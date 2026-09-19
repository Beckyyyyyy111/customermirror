import { LiveAvatarSession, SessionEvent } from "https://esm.sh/@heygen/liveavatar-web-sdk@0.0.12";

const API = "/api";

const screens = {
  brief: document.getElementById("screen-brief"),
  candidates: document.getElementById("screen-candidates"),
  interview: document.getElementById("screen-interview"),
  report: document.getElementById("screen-report"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

// Categorical palette (identity color per persona) — fixed order, never cycled per-render.
const AVATAR_COLORS = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#008300", "#4a3aa7", "#e34948",
];

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Pools of synthetic (AI-generated, non-real-person) LiveTalking avatar_ids, split by
// the gender implied by each persona's name/identity so faces don't get mismatched.
const AVATAR_POOL_FEMALE = ["synthetic1", "synthetic3", "synthetic6", "synthetic9"];
const AVATAR_POOL_MALE = [
  "synthetic2", "synthetic4", "synthetic5", "synthetic7", "synthetic8", "synthetic10", "synthetic11",
];

// The advisor panel is fixed, real people — pin each to its own stand-in avatar so
// they never collide with each other. These are reserved out of the pool below, so a
// customer/investor persona can never end up wearing an advisor's face.
const ADVISOR_AVATAR_ID = {
  "Tim Cook": "synthetic2",
  "Paul Graham": "synthetic8",
  "Warren Buffett": "synthetic5",
  "Reid Hoffman": "synthetic7",
};

// Personas pinned to the paid LiveAvatar cloud avatar instead of the free local one —
// limited credits, so keep this set small and skip the LiveTalking attempt for them.
const LIVEAVATAR_RESERVED_FOR = new Set(["Warren Buffett"]);

let avatarAssignments = {}; // candidate_id -> avatar_id, computed once per candidate slate

function assignAvatars(candidates) {
  const assignments = {};
  const reserved = new Set(Object.values(ADVISOR_AVATAR_ID));
  const freePool = {
    female: AVATAR_POOL_FEMALE.filter((id) => !reserved.has(id)),
    male: AVATAR_POOL_MALE.filter((id) => !reserved.has(id)),
  };
  const usedByGender = { male: new Set(), female: new Set() };

  candidates.forEach((c) => {
    const fixed = ADVISOR_AVATAR_ID[c.name];
    if (fixed) assignments[c.candidate_id] = fixed;
  });

  candidates.forEach((c) => {
    if (assignments[c.candidate_id]) return;
    const pool = freePool[c.gender] || freePool.male;
    const used = usedByGender[c.gender] || (usedByGender[c.gender] = new Set());
    let pick = pool.find((id) => !used.has(id));
    // Pool exhausted for this gender — repeat among this same non-advisor pool
    // (never an advisor's reserved face) rather than leaving it unassigned.
    if (!pick) pick = pool[used.size % pool.length];
    assignments[c.candidate_id] = pick;
    used.add(pick);
  });

  return assignments;
}

let sessionId = null;
let currentCandidates = [];
let activeCandidateId = null;
const candidateInterviewed = new Set();
let lastReport = null;

let mediaStream = null; // combined a/v stream for self-view + recording
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let avatarSession = null;
let avatarReady = false;

// Local, free, self-hosted avatar (LiveTalking) — tried before the paid LiveAvatar cloud service.
const LIVETALKING_URL = "http://localhost:8010";
let ltPeerConnection = null;
let ltSessionId = null;
let ltReady = false;

let audioCtx = null;
let mouthRAF = null;

let timerInterval = null;
let callStartTime = null;

// --- Hands-free auto-listen (voice activity detection) ---
let callActive = false; // true while the interview screen owns the mic
let micMuted = false;
let awaitingReply = false;
let vadAnalyser = null;
let vadDataArray = null;
let vadRAF = null;
let vadHasSpeech = false;
let vadSilenceStartedAt = null;
let vadRecordingStartedAt = null;

const VAD_SPEAK_RMS = 0.02; // amplitude above which we consider the mic "speaking"
const VAD_SILENCE_MS = 1100; // pause length that ends a turn and auto-sends
const VAD_MAX_RECORD_MS = 20000; // safety cap so a stuck mic doesn't record forever

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  document.getElementById("transcript").appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
}

function setCaption(role, text) {
  const box = document.getElementById("captions");
  const cls = role === "founder" ? "cap-founder" : "cap-customer";
  box.innerHTML = `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function setStatus(text) {
  document.getElementById("status-line").textContent = text;
}

function showAvatarFallback(name) {
  document.getElementById("avatar-loading").classList.add("hidden");
  document.getElementById("avatar-head").style.setProperty("--avatar-color", colorForName(name || ""));
  document.getElementById("avatar-fallback").classList.remove("hidden");
}

function hideAvatarFallback() {
  document.getElementById("avatar-fallback").classList.add("hidden");
}

function startMouthSync(analyser, dataArray) {
  stopMouthSync();
  const fallback = document.getElementById("avatar-fallback");
  const mouth = document.getElementById("avatar-mouth");
  function tick() {
    if (fallback.classList.contains("hidden")) {
      mouthRAF = null;
      return;
    }
    analyser.getByteTimeDomainData(dataArray);
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    const openAmount = Math.min(1, rms * 6);
    mouth.setAttribute("ry", (6 + openAmount * 16).toFixed(1));
    mouth.setAttribute("rx", (22 - openAmount * 6).toFixed(1));
    mouthRAF = requestAnimationFrame(tick);
  }
  tick();
}

function stopMouthSync() {
  if (mouthRAF) cancelAnimationFrame(mouthRAF);
  mouthRAF = null;
  const mouth = document.getElementById("avatar-mouth");
  if (mouth) {
    mouth.setAttribute("ry", "6");
    mouth.setAttribute("rx", "22");
  }
}

async function startLiveTalking(candidateId) {
  const loading = document.getElementById("avatar-loading");
  const video = document.getElementById("avatar-video");
  video.muted = false; // a stale background-tab mute from a previous call must never carry over
  ltReady = false;
  hideAvatarFallback();
  loading.classList.remove("hidden");

  const pc = new RTCPeerConnection({ sdpSemantics: "unified-plan" });
  ltPeerConnection = pc;
  let resolveTrack;
  const trackArrived = new Promise((resolve) => {
    resolveTrack = resolve;
  });
  pc.addEventListener("track", (evt) => {
    video.srcObject = evt.streams[0];
    resolveTrack();
  });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });

  const res = await fetch(`${LIVETALKING_URL}/offer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
      avatar: avatarAssignments[candidateId] || AVATAR_POOL_MALE[0],
    }),
  });
  if (!res.ok) throw new Error("LiveTalking server unreachable");
  const answer = await res.json();
  if (!answer.sessionid) throw new Error(answer.msg || "LiveTalking did not return a session");
  ltSessionId = answer.sessionid;
  await pc.setRemoteDescription(answer);

  // Don't declare ready until the video track has actually arrived and attached —
  // otherwise a caller can start driving audio at the element before it has any
  // stream to render, producing sound with no visible avatar (or the reverse).
  await Promise.race([trackArrived, new Promise((r) => setTimeout(r, 8000))]);
  await video.play().catch(() => {});
  ltReady = true;
  loading.classList.add("hidden");
  setStatus("Local digital human connected");
}

async function speakThroughLiveTalking(base64Audio) {
  const byteChars = atob(base64Audio);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: "audio/mpeg" });

  const form = new FormData();
  form.append("sessionid", ltSessionId);
  form.append("file", blob, "reply.mp3");
  const res = await fetch(`${LIVETALKING_URL}/humanaudio`, { method: "POST", body: form });
  if (!res.ok) throw new Error("LiveTalking humanaudio request failed");
}

async function startLiveAvatar() {
  const loading = document.getElementById("avatar-loading");
  const video = document.getElementById("avatar-video");
  video.muted = false; // a stale background-tab mute from a previous call must never carry over
  avatarReady = false;
  hideAvatarFallback();
  loading.classList.remove("hidden");
  const response = await fetch(`${API}/liveavatar/token`, { method: "POST" });
  if (!response.ok) throw new Error((await response.json()).detail || "Could not start LiveAvatar");
  const { session_token: token } = await response.json();
  avatarSession = new LiveAvatarSession(token, { apiUrl: "https://api.liveavatar.com" });
  // avatarSession.start() resolving does NOT mean the stream is actually ready — that's
  // the SESSION_STREAM_READY event, fired separately/later. Waiting only on .start()
  // let callers drive audio at the video element before it had anything to render.
  await new Promise((resolve, reject) => {
    avatarSession.on(SessionEvent.SESSION_STREAM_READY, async () => {
      avatarSession.attach(video);
      await video.play().catch(() => {});
      avatarReady = true;
      loading.classList.add("hidden");
      setStatus("Digital human connected");
      resolve();
    });
    avatarSession.start().catch(reject);
    setTimeout(() => reject(new Error("LiveAvatar stream timed out")), 15000);
  });
}

function estimateSpeechMs(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1200, (words / 2.5) * 1000); // ~150wpm speaking pace, 1.2s floor
}

async function speakThroughAvatar(text, fallbackAudio) {
  const tile = document.getElementById("customer-tile");
  if (ltReady && ltSessionId && fallbackAudio) {
    try {
      tile.classList.add("speaking");
      await speakThroughLiveTalking(fallbackAudio);
      // /humanaudio returns as soon as the clip is queued, not once playback
      // finishes — wait out an estimate so hands-free mode doesn't start
      // listening (and pick up the avatar's own voice) too early.
      await new Promise((r) => setTimeout(r, estimateSpeechMs(text)));
      tile.classList.remove("speaking");
      return;
    } catch {
      tile.classList.remove("speaking");
      ltReady = false; // local server dropped — fall through to the next tier
    }
  }
  if (avatarReady && avatarSession) {
    avatarSession.repeat(text);
    // The SDK's repeat() doesn't return a "finished speaking" promise, so we wait
    // out an estimate — otherwise hands-free mode would start listening (and risk
    // picking up the avatar's own voice) before it's done talking.
    await new Promise((r) => setTimeout(r, estimateSpeechMs(text)));
    return;
  }
  if (fallbackAudio) await playAudioBase64(fallbackAudio);
}

let currentFallbackAudio = null; // tracked so a backgrounded tab can pause it (see visibilitychange below)

function playAudioBase64(b64) {
  return new Promise((resolve) => {
    const ctx = ensureAudioContext();
    const audio = new Audio(`data:audio/mp3;base64,${b64}`);
    currentFallbackAudio = audio;
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const dataArray = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    analyser.connect(ctx.destination);

    const tile = document.getElementById("customer-tile");
    tile.classList.add("speaking");
    startMouthSync(analyser, dataArray);

    const finish = () => {
      tile.classList.remove("speaking");
      stopMouthSync();
      if (currentFallbackAudio === audio) currentFallbackAudio = null;
      resolve();
    };
    audio.addEventListener("ended", finish);
    audio.play().catch(finish);
  });
}

function startTimer() {
  callStartTime = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    document.getElementById("meeting-timer").textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

const productDescriptionInput = document.getElementById("product-description-input");
if (productDescriptionInput) {
  productDescriptionInput.addEventListener("input", () => autoGrowTextarea(productDescriptionInput));
  autoGrowTextarea(productDescriptionInput);
}

document.getElementById("brief-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const brief = {
    product_description: form.get("product_description"),
    target_customer: form.get("target_customer"),
    key_hypothesis: form.get("key_hypothesis"),
    stage: form.get("stage"),
  };

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Generating your panel…";

  try {
    ensureAudioContext(); // must be created on a user gesture

    const res = await fetch(`${API}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(brief),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    sessionId = data.session_id;
    currentCandidates = data.candidates;
    avatarAssignments = assignAvatars(currentCandidates);
    activeCandidateId = null;
    candidateInterviewed.clear();
    lastReport = null;

    renderCandidateGrid();
    showScreen("candidates");
  } catch (err) {
    alert("Could not start session: " + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Meet your simulated panel";
  }
});

const TYPE_LABEL = { customer: "Customer", investor: "Investor", advisor: "Advisor" };
const TYPE_BASIS_LABEL = { customer: "Why this persona", investor: "Why this persona", advisor: "Grounded in" };

function buildCandidateCard(c) {
  const interviewed = candidateInterviewed.has(c.candidate_id);
  const isAdvisor = c.persona_type === "advisor";
  const card = document.createElement("div");
  card.className = "candidate-card";
  card.style.borderLeftColor = colorForName(c.name);
  card.innerHTML = `
    <img class="candidate-photo" src="/avatars/${avatarAssignments[c.candidate_id]}.png" alt="${escapeHtml(c.name)}" />
    <div class="candidate-card-head">
      <span class="badge badge-${c.persona_type}">${TYPE_LABEL[c.persona_type]}</span>
      ${isAdvisor ? '<span class="badge badge-ai">🤖 AI simulation</span>' : ""}
      ${interviewed ? '<span class="badge badge-done">Interviewed</span>' : ""}
    </div>
    <div class="candidate-name">${escapeHtml(c.name)}</div>
    <div class="candidate-role">${escapeHtml(c.role)} — ${escapeHtml(c.company_context)}</div>
    <div class="candidate-tagline">${escapeHtml(c.tagline)}</div>
    <div class="candidate-basis"><strong>${TYPE_BASIS_LABEL[c.persona_type]}:</strong> ${escapeHtml(c.source_basis)}</div>
    <button class="btn-primary candidate-btn" data-id="${c.candidate_id}">
      ${interviewed ? "Continue interview" : "Interview this person"}
    </button>
  `;
  card.querySelector(".candidate-btn").addEventListener("click", () => enterCandidate(c));
  return card;
}

function renderCandidateGrid() {
  const grids = {
    customer: document.getElementById("grid-customer"),
    investor: document.getElementById("grid-investor"),
    advisor: document.getElementById("grid-advisor"),
  };
  Object.values(grids).forEach((g) => (g.innerHTML = ""));

  currentCandidates.forEach((c) => {
    const grid = grids[c.persona_type];
    if (grid) grid.appendChild(buildCandidateCard(c));
  });

  Object.entries(grids).forEach(([type, grid]) => {
    const group = document.getElementById(`group-${type}`);
    group.classList.toggle("hidden", grid.children.length === 0);
  });

  const count = candidateInterviewed.size;
  document.getElementById("candidates-status").textContent =
    count === 0
      ? "Pick someone to interview first."
      : `${count} interview${count === 1 ? "" : "s"} completed. Interview more, or generate the report.`;
  document.getElementById("btn-generate-report").disabled = count === 0;
}

async function enterCandidate(candidate) {
  activeCandidateId = candidate.candidate_id;
  try {
    const res = await fetch(`${API}/sessions/${sessionId}/candidates/${candidate.candidate_id}/enter`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    document.getElementById("persona-name").textContent = data.persona_name;
    document.getElementById("persona-role").textContent = data.persona_role;
    document.getElementById("transcript").innerHTML = "";
    document.getElementById("captions").innerHTML = "";

    const isFirstEntry = data.transcript.length <= 1;
    data.transcript.forEach((t) => addBubble(t.role, t.text));
    if (data.transcript.length) {
      const last = data.transcript[data.transcript.length - 1];
      setCaption(last.role, last.text);
    }

    showScreen("interview");
    startTimer();
    callActive = true;
    micMuted = false;
    micBtn.classList.remove("muted");
    if (LIVEAVATAR_RESERVED_FOR.has(candidate.name)) {
      // This persona is pinned to the paid LiveAvatar cloud avatar (limited credits) —
      // skip the local LiveTalking attempt entirely rather than spending time on it.
      try {
        setStatus("Connecting live digital human…");
        await startLiveAvatar();
      } catch (avatarError) {
        showAvatarFallback(candidate.name);
        setStatus(`Voice-only mode (${avatarError.message})`);
      }
    } else {
      try {
        setStatus("Connecting local digital human…");
        await startLiveTalking(candidate.candidate_id);
      } catch (ltError) {
        try {
          setStatus("Connecting live digital human…");
          await startLiveAvatar();
        } catch (avatarError) {
          showAvatarFallback(candidate.name);
          setStatus(`Voice-only mode (${avatarError.message})`);
        }
      }
    }
    if (isFirstEntry) {
      await speakThroughAvatar(data.opening_line, data.opening_audio_base64);
    }
    armMic();
  } catch (err) {
    alert("Could not start interview: " + err.message);
  }
}

async function sendFounderMessage({ text, blob }) {
  awaitingReply = true;
  setStatus("Thinking…");
  const form = new FormData();
  if (blob) {
    form.append("audio_file", blob, "recording.webm");
  } else {
    form.append("text", text);
  }

  try {
    const res = await fetch(`${API}/sessions/${sessionId}/candidates/${activeCandidateId}/respond`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    candidateInterviewed.add(activeCandidateId);
    addBubble("founder", data.founder_text);
    setCaption("founder", data.founder_text);
    addBubble("customer", data.customer_text);
    setStatus("");
    await new Promise((r) => setTimeout(r, 400));
    setCaption("customer", data.customer_text);
    await speakThroughAvatar(data.customer_text, data.audio_base64);
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    awaitingReply = false;
    armMic();
  }
}

document.getElementById("btn-send").addEventListener("click", () => {
  const input = document.getElementById("text-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendFounderMessage({ text });
});

document.getElementById("text-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-send").click();
});

async function ensureMediaStream(includeVideo = false) {
  if (mediaStream) return mediaStream;
  const selfVideo = document.getElementById("self-video");
  const selfFallback = document.getElementById("self-fallback");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: includeVideo });
  } catch {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  if (includeVideo && mediaStream.getVideoTracks().length) {
    selfVideo.srcObject = mediaStream;
    selfVideo.style.display = "block";
    selfFallback.style.display = "none";
    await selfVideo.play().catch(() => {});
  }
  return mediaStream;
}

const micBtn = document.getElementById("btn-mic");
const cameraBtn = document.getElementById("btn-camera");
const selfTile = document.getElementById("self-tile");

function handleRecordingStop() {
  const blob = new Blob(audioChunks, { type: "audio/webm" });
  if (!callActive) return;
  if (blob.size > 800 && vadHasSpeech) {
    sendFounderMessage({ blob });
  } else {
    // False start or silence-only clip — keep listening instead of sending nothing.
    armMic();
  }
}

function stopRecording() {
  if (!isRecording) return;
  if (vadRAF) cancelAnimationFrame(vadRAF);
  vadRAF = null;
  isRecording = false;
  micBtn.classList.remove("recording");
  selfTile.classList.remove("speaking");
  mediaRecorder.stop();
}

function watchForSilence() {
  if (!isRecording || !vadAnalyser) return;
  vadAnalyser.getByteTimeDomainData(vadDataArray);
  let sumSquares = 0;
  for (let i = 0; i < vadDataArray.length; i++) {
    const v = (vadDataArray[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / vadDataArray.length);
  const now = Date.now();

  if (rms > VAD_SPEAK_RMS) {
    vadHasSpeech = true;
    vadSilenceStartedAt = null;
  } else if (vadHasSpeech) {
    if (vadSilenceStartedAt === null) vadSilenceStartedAt = now;
    else if (now - vadSilenceStartedAt >= VAD_SILENCE_MS) {
      stopRecording();
      return;
    }
  }

  if (now - vadRecordingStartedAt >= VAD_MAX_RECORD_MS) {
    stopRecording();
    return;
  }

  vadRAF = requestAnimationFrame(watchForSilence);
}

async function armMic() {
  if (!callActive || micMuted || isRecording || awaitingReply) return;
  try {
    const stream = await ensureMediaStream(false);
    const audioOnly = new MediaStream(stream.getAudioTracks());

    const ctx = ensureAudioContext();
    const source = ctx.createMediaStreamSource(audioOnly);
    vadAnalyser = ctx.createAnalyser();
    vadAnalyser.fftSize = 1024;
    vadDataArray = new Uint8Array(vadAnalyser.fftSize);
    source.connect(vadAnalyser);

    mediaRecorder = new MediaRecorder(audioOnly);
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();

    isRecording = true;
    vadHasSpeech = false;
    vadSilenceStartedAt = null;
    vadRecordingStartedAt = Date.now();
    micBtn.classList.add("recording");
    micBtn.classList.remove("muted");
    selfTile.classList.add("speaking");
    setStatus("Listening… just talk, it sends automatically when you pause");

    watchForSilence();
  } catch (err) {
    setStatus("Microphone unavailable: " + err.message);
  }
}

micBtn.addEventListener("click", () => {
  if (isRecording) {
    // Manual override: stop early instead of waiting for the silence timeout.
    stopRecording();
    return;
  }
  micMuted = !micMuted;
  micBtn.classList.toggle("muted", micMuted);
  if (micMuted) {
    setStatus("Mic paused — click to resume hands-free listening");
  } else {
    setStatus("");
    armMic();
  }
});

let cameraOn = false;
cameraBtn.addEventListener("click", async () => {
  const selfVideo = document.getElementById("self-video");
  const selfFallback = document.getElementById("self-fallback");
  try {
    const stream = await ensureMediaStream(false);
    let videoTracks = stream.getVideoTracks();
    cameraOn = !cameraOn;
    if (cameraOn && !videoTracks.length) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraStream.getVideoTracks().forEach((track) => stream.addTrack(track));
      videoTracks = stream.getVideoTracks();
    }
    videoTracks.forEach((t) => (t.enabled = cameraOn));
    selfVideo.srcObject = stream;
    selfVideo.style.display = cameraOn ? "block" : "none";
    selfFallback.style.display = cameraOn ? "none" : "flex";
    cameraBtn.classList.toggle("muted", !cameraOn);
    if (cameraOn) await selfVideo.play();
    setStatus(cameraOn ? "Camera on" : "Camera off");
  } catch (err) {
    setStatus("Camera unavailable: " + err.message);
  }
});

document.getElementById("btn-transcript").addEventListener("click", () => {
  document.getElementById("transcript-panel").classList.toggle("hidden");
});
document.getElementById("btn-close-transcript").addEventListener("click", () => {
  document.getElementById("transcript-panel").classList.add("hidden");
});

function stopCall() {
  callActive = false;
  awaitingReply = false;
  stopTimer();
  if (vadRAF) cancelAnimationFrame(vadRAF);
  vadRAF = null;
  if (isRecording) {
    isRecording = false;
    micBtn.classList.remove("recording");
    selfTile.classList.remove("speaking");
    try {
      mediaRecorder.stop();
    } catch {
      // already stopped
    }
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (avatarSession) {
    avatarSession.stop().catch(() => {});
    avatarSession = null;
    avatarReady = false;
  }
  if (ltPeerConnection) {
    ltPeerConnection.close();
    ltPeerConnection = null;
    ltSessionId = null;
    ltReady = false;
  }
}

document.getElementById("btn-end").addEventListener("click", () => {
  stopCall();
  document.getElementById("transcript-panel").classList.add("hidden");
  renderCandidateGrid();
  showScreen("candidates");
});

// If this tab is backgrounded (e.g. a stale interview left open in another tab) mute
// its avatar output and pause hands-free listening, so it can never add a phantom
// extra voice to whichever tab is actually in front of you. Resumes on return.
document.addEventListener("visibilitychange", () => {
  if (!callActive) return;
  const video = document.getElementById("avatar-video");
  if (document.hidden) {
    if (video) video.muted = true;
    if (currentFallbackAudio) currentFallbackAudio.pause();
    if (isRecording) stopRecording();
    micMuted = true;
  } else {
    if (video) video.muted = false;
    micMuted = false;
    armMic();
  }
});

document.getElementById("btn-generate-report").addEventListener("click", async () => {
  const btn = document.getElementById("btn-generate-report");
  btn.disabled = true;
  btn.textContent = "Generating report…";
  try {
    const res = await fetch(`${API}/sessions/${sessionId}/report`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    lastReport = await res.json();
    renderReport(lastReport);
    showScreen("report");
  } catch (err) {
    alert("Could not generate report: " + err.message);
  } finally {
    btn.disabled = candidateInterviewed.size === 0;
    btn.textContent = "Generate report";
  }
});

function confidenceColor(value) {
  if (value >= 0.66) return "var(--good)";
  if (value >= 0.33) return "var(--warning)";
  return "var(--critical)";
}

const CONCERNS_LABEL = {
  customer: "Pain points surfaced",
  investor: "Investment concerns surfaced",
  advisor: "Critiques & concerns raised",
};
const CONCERNS_NOUN = { customer: "pain points", investor: "concerns", advisor: "critiques" };
const COMMITMENT_LABEL = {
  customer: "Willingness to pay — what you actually established",
  investor: "Investment commitment — what you actually established",
  advisor: "Advisor's overall verdict",
};
const REVEAL_LABEL = {
  customer: "Reveal this person's real profile",
  investor: "Reveal this person's real profile",
  advisor: "See the full advisor character sheet",
};

function renderPersonaSection(pi) {
  const insight = pi.insight;
  const type = pi.persona_type;
  const pct = Math.round(insight.confidence * 100);

  const painItems = insight.discovered_pain_points.length
    ? insight.discovered_pain_points
        .map(
          (p) => `
      <div class="pain-item">
        <div class="pain-desc">${escapeHtml(p.description)}</div>
        ${p.supporting_quote ? `<div class="pain-quote">"${escapeHtml(p.supporting_quote)}"</div>` : ""}
        <div class="pain-meter-row">
          <div class="meter-track"><div class="meter-fill" style="width:${p.severity_guess * 10}%"></div></div>
          <span>${p.severity_guess}/10</span>
        </div>
      </div>`
        )
        .join("")
    : `<p class="evidence-text">No concrete ${CONCERNS_NOUN[type]} were confirmed in this interview.</p>`;

  const leadingItems = insight.leading_questions.length
    ? insight.leading_questions
        .map((q) => `<li>“${escapeHtml(q.question)}” <div class="reason">${escapeHtml(q.reason)}</div></li>`)
        .join("")
    : `<li class="evidence-text">None flagged — nicely done.</li>`;

  const goodItems = insight.good_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("");
  const nextItems = insight.next_questions_to_ask.map((q) => `<li>${escapeHtml(q)}</li>`).join("");

  const wrap = document.createElement("div");
  wrap.className = "persona-section";
  wrap.innerHTML = `
    <div class="persona-section-head">
      <img class="persona-photo" src="/avatars/${avatarAssignments[pi.candidate_id]}.png" alt="${escapeHtml(pi.persona_name)}" />
      <span class="badge badge-${type}">${TYPE_LABEL[type]}</span>
      ${type === "advisor" ? '<span class="badge badge-ai">🤖 AI simulation</span>' : ""}
      <h3>${escapeHtml(pi.persona_name)} — ${escapeHtml(pi.persona_role)}</h3>
    </div>
    ${type === "advisor" ? '<p class="advisor-disclaimer">Based on public interviews/writing — not verified or endorsed by the real person.</p>' : ""}

    <div class="stat-row">
      <div class="stat-tile">
        <div class="stat-label">Signal confidence</div>
        <div class="meter-track"><div class="meter-fill" style="width:${pct}%;background:${confidenceColor(insight.confidence)}"></div></div>
        <div class="stat-value">${pct}%</div>
      </div>
    </div>

    <div class="report-section">
      <h3>${CONCERNS_LABEL[type]}</h3>
      <div class="pain-list">${painItems}</div>
    </div>

    <div class="report-section">
      <h3>⚠️ Leading questions to avoid next time</h3>
      <ul class="flagged-list">${leadingItems}</ul>
    </div>

    <div class="report-section">
      <h3>✅ Questions that worked</h3>
      <ul class="good-list">${goodItems}</ul>
    </div>

    <div class="report-section">
      <h3>${COMMITMENT_LABEL[type]}</h3>
      <p class="evidence-text">${escapeHtml(insight.willingness_to_pay_evidence || "Not established in this interview.")}</p>
    </div>

    <div class="report-section">
      <h3>Verdict</h3>
      <p class="evidence-text">${escapeHtml(insight.overall_verdict)}</p>
    </div>

    <div class="report-section">
      <h3>Ask next time</h3>
      <ul>${nextItems}</ul>
    </div>

    <button class="btn-secondary btn-reveal-persona" data-candidate-id="${pi.candidate_id}">${REVEAL_LABEL[type]}</button>
    <div class="reveal-box hidden"></div>
  `;

  wrap.querySelector(".btn-reveal-persona").addEventListener("click", async () => {
    const box = wrap.querySelector(".reveal-box");
    if (box.dataset.loaded) {
      box.classList.toggle("hidden");
      return;
    }
    const res = await fetch(`${API}/sessions/${sessionId}/candidates/${pi.candidate_id}/reveal`);
    const persona = await res.json();
    box.textContent = JSON.stringify(persona, null, 2);
    box.dataset.loaded = "1";
    box.classList.remove("hidden");
  });

  return wrap;
}

function renderReport(report) {
  const container = document.getElementById("report-sections");
  container.innerHTML = "";
  report.persona_insights.forEach((pi) => container.appendChild(renderPersonaSection(pi)));

  const synthesisBlock = document.getElementById("cross-synthesis");
  if (report.cross_persona_synthesis) {
    document.getElementById("cross-synthesis-text").textContent = report.cross_persona_synthesis;
    synthesisBlock.classList.remove("hidden");
  } else {
    synthesisBlock.classList.add("hidden");
  }
}

document.getElementById("btn-download-pdf").addEventListener("click", () => {
  if (!lastReport) return;
  window.location = `${API}/sessions/${sessionId}/report/pdf`;
});

document.getElementById("btn-back-to-candidates").addEventListener("click", () => {
  renderCandidateGrid();
  showScreen("candidates");
});

document.getElementById("btn-restart").addEventListener("click", () => {
  sessionId = null;
  currentCandidates = [];
  activeCandidateId = null;
  candidateInterviewed.clear();
  lastReport = null;
  document.getElementById("brief-form").reset();
  if (productDescriptionInput) autoGrowTextarea(productDescriptionInput);
  document.getElementById("transcript-panel").classList.add("hidden");
  showScreen("brief");
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
