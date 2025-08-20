document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('localVideo')
  const canvas = document.getElementById('overlayCanvas')
  const ctx = canvas.getContext('2d')
  const qrCodeDiv = document.getElementById('qrCode')
  const localUrlSpan = document.getElementById('localUrl')
  const statusSpan = document.getElementById('status')

  // Generate and display QR code
  const protocol = window.location.protocol
  const hostname = window.location.hostname
  const port = window.location.port
  const localUrl = `${protocol}//${hostname}:${port}`
  new QRCode(qrCodeDiv, localUrl)
  localUrlSpan.textContent = localUrl

  // Listen for WebRTC client events
  window.addEventListener('datachannelopen', () => {
    statusSpan.textContent = 'Status: Phone connected! Processing stream...'
  })

  window.addEventListener('datachannelmessage', (event) => {
    const data = JSON.parse(event.detail)
    const detections = data.detections
    const frameId = data.frame_id
    const captureTs = data.capture_ts

    // This is where you would handle the overlay logic
    drawOverlays(video, canvas, detections)

    // This is a crucial part of the project: aligning the overlay with the correct frame.
    // For simplicity, we'll draw it immediately, but in a real-world scenario, you'd
    // need a buffer to align the frame with the detection data.
  })
})

function drawOverlays(video, canvas, detections) {
  const videoWidth = video.videoWidth
  const videoHeight = video.videoHeight

  canvas.width = videoWidth
  canvas.height = videoHeight
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  detections.forEach((detection) => {
    const xmin = detection.xmin * videoWidth
    const ymin = detection.ymin * videoHeight
    const xmax = detection.xmax * videoWidth
    const ymax = detection.ymax * videoHeight

    const width = xmax - xmin
    const height = ymax - ymin

    ctx.strokeStyle = '#00FF00'
    ctx.lineWidth = 2
    ctx.strokeRect(xmin, ymin, width, height)

    ctx.fillStyle = '#00FF00'
    ctx.font = '16px Arial'
    ctx.fillText(
      `${detection.label} (${(detection.score * 100).toFixed(1)}%)`,
      xmin,
      ymin > 10 ? ymin - 5 : 10
    )
  })
}
