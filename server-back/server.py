import os
import cv2
import json
import time
import asyncio
import numpy as np
from aiohttp import web
from aiortc import (
    RTCIceCandidate,
    RTCPeerConnection,
    RTCSessionDescription,
    VideoStreamTrack,
)
from aiortc.contrib.media import MediaRelay

# Check if we are in server mode
SERVER_MODE = os.environ.get("MODE", "server") == "server"

# Load the ONNX model for server mode
if SERVER_MODE:
    import onnxruntime as ort
    model_path = "./models/yolov5n.onnx"
    session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    input_name = session.get_inputs()[0].name
    output_names = [output.name for output in session.get_outputs()]

async def object_detection_server(request):
    params = await request.json()
    peer_connection = RTCPeerConnection()
    relay = MediaRelay()
    data_channel = None

    @peer_connection.on("datachannel")
    def on_datachannel(channel):
        nonlocal data_channel
        data_channel = channel
        print("Data channel opened!")
        @channel.on("message")
        def on_message(message):
            print(f"Received message from client: {message}")

    @peer_connection.on("icecandidate")
    async def on_icecandidate(candidate):
        await data_channel.send(json.dumps({"ice": candidate.candidate}))

    @peer_connection.on("track")
    async def on_track(track):
        print(f"Track {track.kind} received")
        if track.kind == "video":
            video_track = relay.subscribe(track)
            while True:
                try:
                    frame = await video_track.recv()
                    img = frame.to_ndarray(format="bgr24")
                    
                    # Server-side inference
                    if SERVER_MODE:
                        start_inference_ts = time.time()
                        
                        # Preprocess image
                        img_resized = cv2.resize(img, (640, 640))
                        img_normalized = img_resized.transpose(2, 0, 1) / 255.0
                        input_tensor = np.expand_dims(img_normalized, 0).astype(np.float32)

                        # Run inference
                        outputs = session.run(output_names, {input_name: input_tensor})
                        detections = outputs[0]
                        end_inference_ts = time.time()
                        
                        # Dummy post-processing (replace with actual logic)
                        # The detections array will contain [x, y, w, h, confidence, class]
                        # We need to parse this and convert it to normalized coordinates
                        parsed_detections = []
                        if detections.any():
                            for det in detections[0]:
                                parsed_detections.append({
                                    "label": "person", # Placeholder
                                    "score": 0.95,     # Placeholder
                                    "xmin": det[0],    # Placeholder
                                    "ymin": det[1],    # Placeholder
                                    "xmax": det[2],    # Placeholder
                                    "ymax": det[3]     # Placeholder
                                })
                        
                        # Send results back
                        if data_channel and data_channel.readyState == 'open':
                            result_message = {
                                "frame_id": "some_id",
                                "capture_ts": frame.capture_time_ms,
                                "recv_ts": int(time.time() * 1000),
                                "inference_ts": int(start_inference_ts * 1000),
                                "detections": parsed_detections
                            }
                            await data_channel.send(json.dumps(result_message))
                except Exception as e:
                    print(f"Error processing frame: {e}")
                    break

    await peer_connection.setRemoteDescription(RTCSessionDescription(sdp=params["sdp"], type=params["type"]))
    await peer_connection.setLocalDescription(await peer_connection.createAnswer())

    return web.json_response({
        "sdp": peer_connection.localDescription.sdp,
        "type": peer_connection.localDescription.type
    })

async def serve_static(request):
    file_path = f'./frontend/{request.path}'
    if request.path == '/':
        file_path = './frontend/index.html'
    return web.FileResponse(file_path)

if __name__ == "__main__":
    app = web.Application()
    app.router.add_post("/offer", object_detection_server)
    app.router.add_get("/", serve_static)
    app.router.add_get("/js/{file}", serve_static)
    app.router.add_get("/css/{file}", serve_static)
    web.run_app(app, host="0.0.0.0", port=8080)
