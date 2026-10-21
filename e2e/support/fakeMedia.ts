/**
 * Synthetic camera, microphone and screen for call tests, injected before the page's own scripts. Chrome's `--use-fake-device-for-media-stream`
 * needs a working audio stack, which a headless or sandboxed machine often lacks (getUserMedia then never answers); this needs none:
 *   video  a canvas that keeps changing (captureStream), so the encoder has frames to send
 *   audio  a 440 Hz tone written to a MediaStreamTrackGenerator (WebCodecs AudioData), so audio energy statistics move
 * Everything after that is real: the RTCPeerConnections encode, send and decode these tracks between two browser contexts.
 */
export const FAKE_MEDIA_SCRIPT = `(() => {
  const canvasTrack = (color) => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 240;
    const g = c.getContext("2d"); let n = 0;
    setInterval(() => { g.fillStyle = color; g.fillRect(0, 0, 320, 240); g.fillStyle = "#fff"; g.fillRect((n * 7) % 300, (n * 3) % 220, 20, 20); n++; }, 40);
    return c.captureStream(25).getVideoTracks()[0];
  };
  const toneTrack = () => {
    const gen = new MediaStreamTrackGenerator({ kind: "audio" });
    const w = gen.writable.getWriter(); const rate = 48000, n = 480; let t = 0;
    const tick = () => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * 440 * (t + i)) / rate);
      const ad = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round((t / rate) * 1e6), data: d }); t += n; return w.write(ad); };
    setInterval(() => { tick().catch(() => {}); }, 10);
    return gen;
  };
  const md = navigator.mediaDevices;
  md.getUserMedia = async (c) => {
    const s = new MediaStream();
    if (c && c.audio) s.addTrack(toneTrack());
    if (c && c.video) s.addTrack(canvasTrack("#3b5bdb"));
    return s;
  };
  md.getDisplayMedia = async () => new MediaStream([canvasTrack("#2b8a3e")]);
  md.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "mic", label: "Synthetic microphone" }, { kind: "videoinput", deviceId: "cam", label: "Synthetic camera" }];
})();`;
