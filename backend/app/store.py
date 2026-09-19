import uuid
from dataclasses import dataclass, field

from pydantic_ai.messages import ModelMessage

from .models import AggregatedReport, InterviewTurn, Persona, ProductBrief


@dataclass
class CandidateThread:
    candidate_id: str
    persona: Persona
    message_history: list[ModelMessage] = field(default_factory=list)
    transcript: list[InterviewTurn] = field(default_factory=list)
    opening_audio_base64: str | None = None

    @property
    def interviewed(self) -> bool:
        return any(t.role == "founder" for t in self.transcript)


@dataclass
class SessionState:
    session_id: str
    brief: ProductBrief
    candidates: dict[str, CandidateThread] = field(default_factory=dict)
    last_report: AggregatedReport | None = None


_sessions: dict[str, SessionState] = {}


def create_session(brief: ProductBrief, personas: list[Persona]) -> SessionState:
    session_id = uuid.uuid4().hex
    state = SessionState(session_id=session_id, brief=brief)
    for persona in personas:
        candidate_id = uuid.uuid4().hex
        state.candidates[candidate_id] = CandidateThread(candidate_id=candidate_id, persona=persona)
    _sessions[session_id] = state
    return state


def get_session(session_id: str) -> SessionState | None:
    return _sessions.get(session_id)


def get_thread(state: SessionState, candidate_id: str) -> CandidateThread | None:
    return state.candidates.get(candidate_id)
