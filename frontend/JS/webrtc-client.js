const peerConnection = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
})

// A placeholder for signaling with the server
// In a real project, this would be a WebSocket or DataChannel connection
const signalingServer = new WebSocket(`ws://${window.location.hostname}:8080`)

signalingServer.onmessage = async (event) => {
  const message = JSON.parse(event.data)
  if (message.sdp) {
    try {
      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(message.sdp)
      )
      if (peerConnection.remoteDescription.type === 'offer') {
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        signalingServer.send(
          JSON.stringify({ sdp: peerConnection.localDescription })
        )
      }
    } catch (e) {
      console.error('Error setting remote description:', e)
    }
  } else if (message.ice) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(message.ice))
    } catch (e) {
      console.error('Error adding ICE candidate:', e)
    }
  }
}

peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    signalingServer.send(JSON.stringify({ ice: event.candidate }))
  }
}

// Listen for incoming video track from the phone
peerConnection.ontrack = (event) => {
  const video = document.getElementById('localVideo')
  if (event.streams && event.streams[0]) {
    video.srcObject = event.streams[0]
  }
}

// This is where we receive the detection results from the server
peerConnection.ondatachannel = (event) => {
  const dataChannel = event.channel
  dataChannel.onmessage = (event) => {
    window.dispatchEvent(
      new CustomEvent('datachannelmessage', { detail: event.data })
    )
  }
  dataChannel.onopen = () => {
    window.dispatchEvent(new CustomEvent('datachannelopen'))
  }
}
