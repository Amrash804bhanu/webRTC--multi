import asyncio
import json
import logging
import time
import numpy as np
import onnxruntime as ort
from websockets.server import serve
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack, RTCIceCandidate
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("server")

# Global variables for signaling and peer connections
WEBSOCKET_CONNECTIONS = set()
PEER_CONNECTIONS = set()

# --- ONNX Model Loading (Server-side) ---
MODEL_PATH = "models/yolov5n.onnx"
INFERENCE_SESSION = None
MODEL_INPUT_SHAPE = (1, 3, 240, 320)

async def load_onnx_model():
    """Loads the ONNX model for server-side inference."""
    global INFERENCE_SESSION
    try:
        INFERENCE_SESSION = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
        logger.info(f"ONNX model loaded successfully: {MODEL_PATH}")
    except Exception as e:
        logger.error(f"Failed to load ONNX model: {e}")
        INFERENCE_SESSION = None

# --- WebRTC Video Track Handling ---
class CustomVideoProcessor(VideoStreamTrack):
    """
    A video track that receives frames, processes them with ONNX,
    and sends detection results.
    """
    def __init__(self, track, peer_id, websocket_connection):
        super().__init__()
        self.track = track
        self.peer_id = peer_id
        self.websocket_connection = websocket_connection
        self.frame_id_counter = 0
        self.last_inference_time = 0
        self.target_fps = 15
        self.min_frame_interval = 1 / self.target_fps
        self.processing_queue = asyncio.Queue(maxsize=5)

    async def recv(self):
        frame = await self.track.recv()
        capture_ts = time.time() * 1000
        self.frame_id_counter += 1
        frame_id = f"server-frame-{self.frame_id_counter}"

        try:
            if self.processing_queue.full():
                await self.processing_queue.get_nowait()
                logger.warning(f"Frame queue full for {self.peer_id}, dropping oldest frame.")
            await self.processing_queue.put((frame, capture_ts, frame_id))
        except asyncio.QueueFull:
            logger.warning(f"Failed to add frame to queue for {self.peer_id}. Queue is full.")

        if not self.processing_queue.empty() and \
           (time.time() - self.last_inference_time) >= self.min_frame_interval:
            await self.process_next_frame()

        return frame

    async def process_next_frame(self):
        if INFERENCE_SESSION is None:
            logger.warning("Inference model not loaded on server.")
            return

        try:
            frame, capture_ts, frame_id = await self.processing_queue.get_nowait()
        except asyncio.QueueEmpty:
            return

        self.last_inference_time = time.time()
        recv_ts = time.time() * 1000

        img = Image.frombytes("RGB", (frame.width, frame.height), frame.to_rgb().tobytes())
        img_resized = img.resize((MODEL_INPUT_SHAPE[3], MODEL_INPUT_SHAPE[2]), Image.LANCZOS)
        img_np = np.array(img_resized).astype(np.float32)

        img_np = img_np / 255.0
        img_np = np.transpose(img_np, (2, 0, 1))
        input_tensor = np.expand_dims(img_np, axis=0)

        inference_ts_start = time.time() * 1000
        detections = []
        try:
            input_name = INFERENCE_SESSION.get_inputs()[0].name
            output_name = INFERENCE_SESSION.get_outputs()[0].name
            outputs = INFERENCE_SESSION.run([output_name], {input_name: input_tensor})
            output_data = outputs[0]

            for det in output_data[0]:
                score = det[4]
                class_id = int(det[5])
                if score > 0.5:
                    detections.append({
                        "label": f"Object {class_id}",
                        "score": float(score),
                        "xmin": float(det[0]),
                        "ymin": float(det[1]),
                        "xmax": float(det[2]),
                        "ymax": float(det[3])
                    })
        except Exception as e:
            logger.error(f"Server inference failed: {e}")

        inference_ts_end = time.time() * 1000

        payload = {
            "frame_id": frame_id,
            "capture_ts": capture_ts,
            "recv_ts": recv_ts,
            "inference_ts": inference_ts_end,
            "detections": detections
        }

        message = json.dumps({"type": "detection_results", "payload": payload})
        try:
            await self.websocket_connection.send(message)
        except Exception as e:
            logger.error(f"Failed to send detection results via WebSocket: {e}")

# --- WebSocket Signaling and WebRTC Session Management ---
async def websocket_handler(websocket, path):
    """Handles WebSocket connections for signaling."""
    WEBSOCKET_CONNECTIONS.add(websocket)
    peer_connection = RTCPeerConnection()
    PEER_CONNECTIONS.add(peer_connection)
    peer_id = f"peer-{id(peer_connection)}"
    logger.info(f"New WebSocket connection and peer connection: {peer_id}")

    # Define WebRTC event handlers first
    @peer_connection.on("track")
    async def on_track(track):
        logger.info(f"Track {track.kind} received from {peer_id}")
        if track.kind == "video":
            video_processor = CustomVideoProcessor(track, peer_id, websocket)
            # You might want to add this processed track back to the peer_connection
            # if you intend to send processed video back to the client, but for overlay
            # it's not strictly necessary.
            # peer_connection.addTrack(video_processor)
            pass

    @peer_connection.on("icecandidate")
    async def on_icecandidate(candidate):
        if candidate:
            message = json.dumps({"type": "candidate", "candidate": candidate.json()})
            await websocket.send(message)

    try:
        # Loop to process WebSocket messages
        async for message in websocket:
            data = json.loads(message)

            if data["type"] == "offer":
                await peer_connection.setRemoteDescription(
                    RTCSessionDescription(sdp=data["sdp"], type="offer")
                )
                answer = await peer_connection.createAnswer()
                await peer_connection.setLocalDescription(answer)
                response = {"type": "answer", "sdp": answer.sdp}
                await websocket.send(json.dumps(response))
            elif data["type"] == "answer":
                await peer_connection.setRemoteDescription(
                    RTCSessionDescription(sdp=data["sdp"], type="answer")
                )
            elif data["type"] == "candidate":
                await peer_connection.addIceCandidate(
                    RTCIceCandidate(data["candidate"])
                )
            # Handler for saving metrics data
            elif data["type"] == "metrics_data":
                with open("metrics.json", "w") as f:
                    json.dump(data["payload"], f, indent=4)
                logger.info("Metrics data saved to metrics.json")

    except Exception as e:
        logger.error(f"WebSocket or WebRTC error for {peer_id}: {e}")
    finally:
        logger.info(f"Closing peer connection: {peer_id}")
        await peer_connection.close() # Use await to properly close
        PEER_CONNECTIONS.remove(peer_connection)
        WEBSOCKET_CONNECTIONS.remove(websocket)


async def main():
    await load_onnx_model()
    logger.info("Starting WebSocket server on ws://0.0.0.0:8080")
    async with serve(websocket_handler, "0.0.0.0", 8080):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())