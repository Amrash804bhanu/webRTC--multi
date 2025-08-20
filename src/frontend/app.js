import * as ort from 'onnxruntime-web' // For WASM mode inference

document.addEventListener('DOMContentLoaded', () => {
  const localVideo = document.getElementById('localVideo')
  const overlayCanvas = document.getElementById('overlayCanvas')
  const remoteVideo = document.getElementById('remoteVideo') // Will be hidden, but useful for understanding
  const startButton = document.getElementById('startButton')
  const qrCodeContainer = document.getElementById('qrCodeContainer')
  const localUrlSpan = document.getElementById('localUrl')
  const loadingIndicator = document.getElementById('loadingIndicator')

  const e2eLatencySpan = document.getElementById('e2eLatency')
  const processedFpsSpan = document.getElementById('processedFps')
  const uplinkKbpsSpan = document.getElementById('uplinkKbps')
  const downlinkKbpsSpan = document.getElementById('downlinkKbps')

  let localStream
  let peerConnection
  let dataChannel
  let ws // WebSocket for signaling and results
  let currentMode = 'wasm' // Default mode, can be 'wasm' or 'server'
  let inferenceSession // ONNX Runtime inference session
  let modelInputShape // e.g., [1, 3, 320, 240] or [1, 3, 640, 640]
  const MODEL_PATH = 'models/yolov5n.onnx' // Placeholder, replace with your model

  const processedFrames = new Map() // Store frames for latency calculation {frame_id: {capture_ts, display_ts}}
  let detectionCount = 0
  let startTime = 0

  // Configuration for RTCPeerConnection
  const configuration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], // STUN server for NAT traversal
  }

  // --- Utility Functions ---

  function showLoading(message) {
    loadingIndicator.textContent = message
    loadingIndicator.classList.remove('hidden')
  }

  function hideLoading() {
    loadingIndicator.classList.add('hidden')
  }

  // Function to draw bounding boxes on canvas
  function drawBBoxes(detections, videoElement, canvas) {
    const ctx = canvas.getContext('2d')
    const videoWidth = videoElement.videoWidth
    const videoHeight = videoElement.videoHeight

    // Ensure canvas dimensions match video for correct overlay
    if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
      canvas.width = videoWidth
      canvas.height = videoHeight
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = '16px Arial'
    ctx.lineWidth = 2

    detections.forEach((det) => {
      const { label, score, xmin, ymin, xmax, ymax } = det

      // Convert normalized coordinates [0,1] to pixel coordinates
      const x = xmin * videoWidth
      const y = ymin * videoHeight
      const width = (xmax - xmin) * videoWidth
      const height = (ymax - ymin) * videoHeight

      // Draw bounding box
      ctx.strokeStyle = '#00FF00' // Green color
      ctx.strokeRect(x, y, width, height)

      // Draw label background
      ctx.fillStyle = '#00FF00'
      const text = `${label} (${(score * 100).toFixed(1)}%)`
      const textMetrics = ctx.measureText(text)
      ctx.fillRect(x, y - 20, textMetrics.width + 10, 20)

      // Draw label text
      ctx.fillStyle = 'black'
      ctx.fillText(text, x + 5, y - 5)
    })
  }

  // Function to process video frames for inference (WASM mode)
  async function processFrameWASM(videoElement) {
    if (!inferenceSession) return

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const targetWidth = 320 // Low-resource mode downscale
    const targetHeight = 240 // Low-resource mode downscale

    canvas.width = targetWidth
    canvas.height = targetHeight
    ctx.drawImage(videoElement, 0, 0, targetWidth, targetHeight)

    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight)
    const { data, width, height } = imageData

    // Preprocessing for the ONNX model (example for YOLOv5/MobileNet-SSD)
    // This part is model-specific and might need adjustments.
    // Common preprocessing: resize, normalize, permute to CHW (Channel, Height, Width)
    const input = new Float32Array(1 * 3 * width * height)
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < width; j++) {
        const pixelIndex = (i * width + j) * 4
        // Normalize to [0, 1] and permute to CHW
        input[0 * width * height + i * width + j] = data[pixelIndex + 0] / 255.0 // R
        input[1 * width * height + i * width + j] = data[pixelIndex + 1] / 255.0 // G
        input[2 * width * height + i * width + j] = data[pixelIndex + 2] / 255.0 // B
      }
    }

    const inputTensor = new ort.Tensor('float32', input, [1, 3, height, width])
    const feeds = { images: inputTensor } // 'images' is a common input name for detection models

    try {
      const results = await inferenceSession.run(feeds)
      // Post-processing: Extract detections from results (model-specific)
      // This is highly dependent on your ONNX model's output format.
      // Example: results might contain a 'output' tensor with shape [1, N_DETECTIONS, 6] (x, y, w, h, score, class_id)
      const outputTensor = results.output // Adjust this key based on your model's output name

      const detections = []
      // Simplified example of parsing output:
      // Assuming outputTensor.data contains [x1, y1, x2, y2, score, class_id, ...] for each detection
      // You'll need actual NMS (Non-Maximum Suppression) if not built into the model.
      for (let i = 0; i < outputTensor.data.length; i += 6) {
        // Assuming 6 values per detection
        const score = outputTensor.data[i + 4]
        const classId = outputTensor.data[i + 5]
        if (score > 0.5) {
          // Confidence threshold
          detections.push({
            label: `Object ${classId}`, // Map class_id to actual label names
            score: score,
            xmin: outputTensor.data[i + 0],
            ymin: outputTensor.data[i + 1],
            xmax: outputTensor.data[i + 2],
            ymax: outputTensor.data[i + 3],
          })
        }
      }
      return detections
    } catch (e) {
      console.error('Inference failed:', e)
      return []
    }
  }

  // --- WebRTC & Signaling ---

  async function startWebRTC() {
    try {
      // Get local media stream (from phone's camera)
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      })
      localVideo.srcObject = localStream

      // Set up local video dimensions for overlay canvas
      localVideo.onloadedmetadata = () => {
        overlayCanvas.width = localVideo.videoWidth
        overlayCanvas.height = localVideo.videoHeight
      }

      peerConnection = new RTCPeerConnection(configuration)

      // Add local stream tracks to peer connection
      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream)
      })

      // Handle ICE candidates
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          ws.send(
            JSON.stringify({ type: 'candidate', candidate: event.candidate })
          )
        }
      }

      // Handle remote tracks (not strictly needed for phone->browser->inference, but good practice)
      peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0]
      }

      // Create a DataChannel for sending video frames or receiving inference results (alternative to WebSocket for results)
      dataChannel = peerConnection.createDataChannel('video_data')
      dataChannel.onopen = () => console.log('Data channel opened')
      dataChannel.onmessage = (event) => {
        // Handle messages from server (e.g., detection results)
        const data = JSON.parse(event.data)
        if (data.type === 'detection_results') {
          // Update overlay and calculate latency
          handleDetectionResults(data.payload)
        }
      }
      dataChannel.onclose = () => console.log('Data channel closed')
      dataChannel.onerror = (error) =>
        console.error('Data channel error:', error)

      // Create offer and send to signaling server
      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }))

      // Start sending frames for WASM inference directly or via DataChannel to backend
      if (currentMode === 'wasm') {
        startWASMInferenceLoop()
      } else {
        // If server mode, video frames are automatically sent via WebRTC to server.
        // DataChannel can be used for occasional control messages or specific data.
      }

      startTime = Date.now() // Start timing for metrics
    } catch (error) {
      console.error('Error starting WebRTC:', error)
      alert(
        'Error accessing camera or setting up WebRTC. Check console for details.'
      )
    }
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.hostname}:8080/ws` // Assuming backend WebSocket on port 8080
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      console.log('WebSocket connected.')
      // Only attempt WebRTC after WebSocket is open
      // startWebRTC(); // Moved to button click
      hideLoading()
    }

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data)

      if (message.type === 'offer') {
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription({ type: 'offer', sdp: message.sdp })
        )
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }))
      } else if (message.type === 'answer') {
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription({ type: 'answer', sdp: message.sdp })
        )
      } else if (message.type === 'candidate') {
        await peerConnection.addIceCandidate(
          new RTCIceCandidate(message.candidate)
        )
      } else if (message.type === 'detection_results') {
        handleDetectionResults(message.payload)
      }
    }

    ws.onclose = () => console.log('WebSocket disconnected.')
    ws.onerror = (error) => console.error('WebSocket error:', error)
  }

  function handleDetectionResults(payload) {
    const { frame_id, capture_ts, recv_ts, inference_ts, detections } = payload

    // Find the corresponding frame to calculate E2E latency
    if (processedFrames.has(frame_id)) {
      const frameData = processedFrames.get(frame_id)
      frameData.overlay_display_ts = Date.now()
      const e2eLatency = frameData.overlay_display_ts - frameData.capture_ts
      console.log(`Frame ${frame_id}: E2E Latency: ${e2eLatency}ms`)
      // Store or process latency for metrics.json
      updateMetrics(e2eLatency, 'e2e')
      processedFrames.delete(frame_id) // Clean up
    }

    // Draw overlays on the canvas
    // It's crucial that `localVideo` is displaying the actual video from the phone
    // for correct alignment.
    drawBBoxes(detections, localVideo, overlayCanvas)
    detectionCount++
  }

  // --- WASM Inference Loop (for `wasm` mode) ---
  let frameQueue = []
  const MAX_QUEUE_SIZE = 5 // For frame thinning / backpressure
  let lastProcessedFrameTime = 0
  const TARGET_FPS = 15 // Target processing FPS for low-resource mode
  const MIN_FRAME_INTERVAL = 1000 / TARGET_FPS

  function startWASMInferenceLoop() {
    const captureFrame = () => {
      if (!localVideo || localVideo.paused || localVideo.ended) {
        requestAnimationFrame(captureFrame)
        return
      }

      const now = Date.now()
      const capture_ts = now
      const frame_id = `frame-${now}` // Unique ID for this frame

      // Simulate sending frame to a "local processing queue" for latency tracking
      processedFrames.set(frame_id, { capture_ts: capture_ts })

      // Frame thinning: Only process if enough time has passed since last frame
      if (now - lastProcessedFrameTime < MIN_FRAME_INTERVAL) {
        requestAnimationFrame(captureFrame)
        return
      }

      // Backpressure: Drop old frames if queue is too long
      if (frameQueue.length >= MAX_QUEUE_SIZE) {
        frameQueue.shift() // Drop the oldest frame
        console.warn('Frame queue overloaded, dropping oldest frame.')
      }

      // Add current frame to queue
      frameQueue.push({ videoElement: localVideo, frame_id, capture_ts })

      // Process the latest frame from the queue
      if (frameQueue.length > 0) {
        const latestFrame = frameQueue.pop() // Process the newest frame
        lastProcessedFrameTime = now

        ////////////////////////////////////////////////////////////////////////////////////////////////processframeWASM
        processFrameWASM(latestFrame.videoElement).then((detections) => {
          const inference_ts = Date.now() // After inference
          // Simulate receiving from server for metrics payload structure
          const mockPayload = {
            frame_id: latestFrame.frame_id,
            capture_ts: latestFrame.capture_ts,
            recv_ts: latestFrame.capture_ts, // In WASM mode, recv_ts is same as capture_ts
            inference_ts: inference_ts,
            detections: detections,
          }
          handleDetectionResults(mockPayload)
        })
      }

      requestAnimationFrame(captureFrame)
    }
    requestAnimationFrame(captureFrame) // Start the loop
  }

  // --- Metrics Collection ---
  let e2eLatencies = []
  let fpsCounterInterval

  function updateMetrics(value, type) {
    if (type === 'e2e') {
      e2eLatencies.push(value)
      const medianLatency = calculateMedian(e2eLatencies)
      e2eLatencySpan.textContent = `${medianLatency.toFixed(2)} ms`
    }
    // Bandwidth calculation using RTCPeerConnection.getStats()
    // This is complex and requires parsing WebRTC stats.
    // For a beginner, often easier to observe in Chrome DevTools -> Network or webrtc-internals.
    // I'll provide a placeholder.
  }

  function calculateMedian(arr) {
    if (arr.length === 0) return 0
    const sorted = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2
  }

  function startFpsCounter() {
    fpsCounterInterval = setInterval(() => {
      const duration = (Date.now() - startTime) / 1000 // seconds
      if (duration > 0) {
        const currentFps = detectionCount / duration
        processedFpsSpan.textContent = currentFps.toFixed(2)
        // Reset for next interval (optional, or accumulate for total run)
        // detectionCount = 0;
        // startTime = Date.now();
      }
    }, 1000) // Update every second
  }

  function stopFpsCounter() {
    clearInterval(fpsCounterInterval)
  }

  async function collectFinalMetrics() {
    // Collect P95 latency
    e2eLatencies.sort((a, b) => a - b)
    const p95Index = Math.ceil(e2eLatencies.length * 0.95) - 1
    const p95Latency = e2eLatencies[p95Index] || 0
    const medianLatency = calculateMedian(e2eLatencies)

    const finalDuration = (Date.now() - startTime) / 1000
    const finalProcessedFps = detectionCount / finalDuration

    // Placeholder for bandwidth (needs getStats() implementation)
    let uplink = 'N/A'
    let downlink = 'N/A'
    if (peerConnection) {
      // Example of using getStats (highly simplified, actual parsing is complex)
      const stats = await peerConnection.getStats(null)
      stats.forEach((report) => {
        if (report.type === 'outbound-rtp' && report.isRemote === false) {
          uplink = (report.bytesSent * 8) / (Date.now() - startTime) / 1000 // rough kbps
        }
        if (report.type === 'inbound-rtp' && report.isRemote === false) {
          downlink =
            (report.bytesReceived * 8) / (Date.now() - startTime) / 1000 // rough kbps
        }
      })
    }

    const metrics = {
      median_e2e_latency_ms: medianLatency.toFixed(2),
      p95_e2e_latency_ms: p95Latency.toFixed(2),
      processed_fps: finalProcessedFps.toFixed(2),
      uplink_kbps: uplink === 'N/A' ? 'N/A' : uplink.toFixed(2),
      downlink_kbps: downlink === 'N/A' ? 'N/A' : downlink.toFixed(2),
    }
    console.log('Final Metrics:', metrics)
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'metrics_data',
          payload: metrics,
        })
      )
    }
  }

  // --- Initialization ---
  startButton.addEventListener('click', async () => {
    startButton.disabled = true
    showLoading('Connecting to server...')

    // Correct place to call the QR code function
    function generateQrCode() {
      const currentUrl = window.location.origin // Gets "http://localhost:3000" or ngrok URL
      localUrlSpan.textContent = currentUrl

      const qrCodeContainer = document.getElementById('qrCodeContainer')
      const urlToShare = currentUrl + `?mode=${currentMode}`

      new QRCode(qrCodeContainer, {
        text: urlToShare,
        width: 128,
        height: 128,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      })
      console.log('Scan this URL:', urlToShare)
    }

    currentMode = window.location.search.includes('mode=server')
      ? 'server'
      : 'wasm'
    generateQrCode()

    if (currentMode === 'wasm') {
      showLoading('Loading ONNX model...')
      try {
        // Your existing model loading code...
        const response = await fetch(MODEL_PATH)
        if (!response.ok)
          throw new Error(`Failed to load model: ${response.statusText}`)
        const modelBuffer = await response.arrayBuffer()

        inferenceSession = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        })
        console.log('ONNX model loaded successfully for WASM inference.')
        modelInputShape = [1, 3, 240, 320]

        hideLoading()
        connectWebSocket()
        await startWebRTC()
        startFpsCounter()
      } catch (e) {
        console.error('Failed to load ONNX model or initialize inference:', e)
        alert('Failed to load detection model. Check console.')
        startButton.disabled = false
        hideLoading()
      }
    } else {
      connectWebSocket()
      await startWebRTC()
      startFpsCounter()
      hideLoading()
    }
  })

  // Event listener for when the page is about to unload (for metrics)
  window.addEventListener('beforeunload', () => {
    stopFpsCounter()
    collectFinalMetrics()
  })
})
