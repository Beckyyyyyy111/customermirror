import asyncio
import base64
from pathlib import Path
import httpx

from fastapi import FastAPI, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import agents, audio, report_pdf, store
from .models import AggregatedReport, CandidateCard, InterviewTurn, PersonaInsight, ProductBrief
from . import config

app = FastAPI(title="AI Customer Interview Simulator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok", "liveavatar_configured": bool(config.LIVEAVATAR_API_KEY and config.LIVEAVATAR_AVATAR_ID)}


@app.post("/api/liveavatar/token")
async def create_liveavatar_token():
    """Mint a short-lived browser token without exposing the provider API key."""
    if not config.LIVEAVATAR_API_KEY or not config.LIVEAVATAR_AVATAR_ID:
        raise HTTPException(status_code=503, detail="LiveAvatar is not configured. Set LIVEAVATAR_API_KEY and LIVEAVATAR_AVATAR_ID.")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{config.LIVEAVATAR_API_URL}/v1/sessions/token",
            headers={"X-API-KEY": config.LIVEAVATAR_API_KEY, "Content-Type": "application/json"},
            json={
                "mode": "FULL",
                "avatar_id": config.LIVEAVATAR_AVATAR_ID,
                "avatar_persona": {},
                "is_sandbox": config.LIVEAVATAR_SANDBOX,
            },
        )
    if response.is_error:
        raise HTTPException(status_code=response.status_code, detail=response.text[:500])
    payload = response.json().get("data", {})
    if not payload.get("session_token"):
        raise HTTPException(status_code=502, detail="LiveAvatar returned no session token")
    return {"session_token": payload["session_token"], "session_id": payload.get("session_id")}


@app.post("/api/sessions")
async def start_session(brief: ProductBrief):
    customer_investor_personas, advisor_personas = await asyncio.gather(
        agents.generate_candidate_slate(brief),
        agents.build_advisor_candidates(brief),
    )
    personas = customer_investor_personas + advisor_personas
    state = store.create_session(brief, personas)

    candidates = [
        CandidateCard(
            candidate_id=thread.candidate_id,
            persona_type=thread.persona.persona_type,
            name=thread.persona.name,
            gender=thread.persona.gender,
            role=thread.persona.role,
            company_context=thread.persona.company_context,
            decision_power=thread.persona.decision_power,
            tagline=thread.persona.tagline,
            source_basis=thread.persona.source_basis,
        )
        for thread in state.candidates.values()
    ]
    return {"session_id": state.session_id, "candidates": candidates}


def _get_state(session_id: str):
    state = store.get_session(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return state


def _get_thread(session_id: str, candidate_id: str):
    state = _get_state(session_id)
    thread = store.get_thread(state, candidate_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return state, thread


@app.post("/api/sessions/{session_id}/candidates/{candidate_id}/enter")
async def enter_candidate(session_id: str, candidate_id: str):
    _, thread = _get_thread(session_id, candidate_id)

    if not thread.transcript:
        opening_audio = await audio.synthesize(thread.persona.opening_line, voice=thread.persona.voice)
        thread.opening_audio_base64 = base64.b64encode(opening_audio).decode()
        thread.transcript.append(InterviewTurn(role="customer", text=thread.persona.opening_line))

    return {
        "candidate_id": thread.candidate_id,
        "persona_name": thread.persona.name,
        "persona_role": thread.persona.role,
        "persona_type": thread.persona.persona_type,
        "opening_line": thread.persona.opening_line,
        "opening_audio_base64": thread.opening_audio_base64,
        "transcript": thread.transcript,
    }


@app.post("/api/sessions/{session_id}/candidates/{candidate_id}/respond")
async def respond(
    session_id: str,
    candidate_id: str,
    text: str | None = Form(default=None),
    audio_file: UploadFile | None = None,
):
    state, thread = _get_thread(session_id, candidate_id)

    if audio_file is not None:
        raw = await audio_file.read()
        founder_text = await audio.transcribe(raw, audio_file.filename or "audio.webm")
    elif text:
        founder_text = text
    else:
        raise HTTPException(status_code=400, detail="Provide text or audio_file")

    reply_text, new_messages = await agents.interview_reply(
        thread.persona, state.brief, thread.message_history, founder_text
    )
    thread.message_history.extend(new_messages)
    thread.transcript.append(InterviewTurn(role="founder", text=founder_text))
    thread.transcript.append(InterviewTurn(role="customer", text=reply_text))

    reply_audio = await audio.synthesize(reply_text, voice=thread.persona.voice)

    return {
        "founder_text": founder_text,
        "customer_text": reply_text,
        "audio_base64": base64.b64encode(reply_audio).decode(),
    }


@app.post("/api/sessions/{session_id}/report", response_model=AggregatedReport)
async def generate_report(session_id: str):
    state = _get_state(session_id)
    interviewed = [t for t in state.candidates.values() if t.interviewed]
    if not interviewed:
        raise HTTPException(status_code=400, detail="No interviews completed yet")

    def _transcript_text(thread) -> str:
        return "\n".join(
            f"{'Founder' if t.role == 'founder' else thread.persona.name}: {t.text}"
            for t in thread.transcript
        )

    insights = await asyncio.gather(
        *[agents.analyze_interview(t.persona, state.brief, _transcript_text(t)) for t in interviewed]
    )

    persona_insights = [
        PersonaInsight(
            candidate_id=thread.candidate_id,
            persona_name=thread.persona.name,
            persona_role=thread.persona.role,
            persona_type=thread.persona.persona_type,
            insight=insight,
        )
        for thread, insight in zip(interviewed, insights)
    ]

    synthesis = None
    if len(persona_insights) > 1:
        synthesis = await agents.synthesize_across_personas(state.brief, persona_insights)

    report = AggregatedReport(persona_insights=persona_insights, cross_persona_synthesis=synthesis)
    state.last_report = report
    return report


@app.get("/api/sessions/{session_id}/report/pdf")
async def download_report_pdf(session_id: str):
    state = _get_state(session_id)
    if state.last_report is None:
        raise HTTPException(status_code=409, detail="Generate the report first")

    pdf_bytes = report_pdf.build_report_pdf(state.brief, state.last_report)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="customer-mirror-report.pdf"'},
    )


@app.get("/api/sessions/{session_id}/candidates/{candidate_id}/reveal")
async def reveal_persona(session_id: str, candidate_id: str):
    _, thread = _get_thread(session_id, candidate_id)
    return thread.persona


FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
