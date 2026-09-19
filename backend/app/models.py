from typing import Literal

from pydantic import BaseModel, Field


class ProductBrief(BaseModel):
    product_description: str
    target_customer: str
    key_hypothesis: str
    stage: str = "idea"


class Persona(BaseModel):
    """Ground truth for a simulated customer or investor. Secret fields are
    never sent to the frontend until earned — either through a reveal after
    interviewing them, or never at all if the founder skips them."""

    persona_type: Literal["customer", "investor", "advisor"]
    name: str
    gender: Literal["male", "female"] = Field(
        description="The gender implied by this persona's name and identity — used to pick a "
        "matching avatar likeness on the frontend."
    )
    role: str = Field(
        description="Customer: job title. Investor: title at their fund, e.g. 'Principal, seed fund'. "
        "Advisor: their real-world title."
    )
    company_context: str
    status_quo: str = Field(
        description="Customer: what they use today instead of the founder's product. "
        "Investor: how they currently source/evaluate deals in this space."
    )
    key_concerns: list[str] = Field(
        description="Customer: actual problems this persona has, ranked by severity. "
        "Investor: real reservations about backing this idea (market, team, timing, moat), ranked by severity."
    )
    concern_severity: dict[str, int] = Field(
        description="Map from each concern (verbatim) to a 1-10 severity/deal-breaker score"
    )
    resource_range: str = Field(
        description="Customer: budget range. Investor: typical check size range."
    )
    decision_power: str = Field(
        description="e.g. 'sole decision maker', 'needs manager approval', 'needs partner sign-off'"
    )
    hidden_objections: list[str] = Field(
        description="Concerns this persona won't volunteer unless asked well"
    )
    commitment_truth: str = Field(
        description="Customer: the real, private answer to whether/how much they'd pay. "
        "Investor: the real, private answer to whether/how much they'd invest."
    )
    guardedness: int = Field(
        ge=1, le=10, description="1 = open book, 10 = gives one-word answers"
    )
    opening_line: str = Field(
        description="What this persona says first when the interview begins"
    )
    voice: str = Field(
        description="One of: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar"
    )
    tagline: str = Field(
        description="One short, punchy sentence for a selection-card headline, specific to this "
        "persona and brief — not generic filler, e.g. 'Skeptical seed VC who's passed on 3 similar pitches.'"
    )
    source_basis: str = Field(
        description="2-4 sentences grounding WHY this persona's specific concerns/objections are "
        "realistic given the product brief and target market — concrete reasoning a discerning "
        "founder would find credible, not a canned line."
    )


class CandidateCard(BaseModel):
    """Display-safe subset of a Persona shown before the founder has earned anything."""

    candidate_id: str
    persona_type: Literal["customer", "investor", "advisor"]
    name: str
    gender: Literal["male", "female"]
    role: str
    company_context: str
    decision_power: str
    tagline: str
    source_basis: str


class InterviewTurn(BaseModel):
    role: str  # "founder" | "customer"
    text: str


class PainPoint(BaseModel):
    description: str
    supporting_quote: str | None = None
    severity_guess: int = Field(ge=1, le=10)


class FlaggedQuestion(BaseModel):
    question: str
    reason: str


class InterviewInsight(BaseModel):
    discovered_pain_points: list[PainPoint]
    leading_questions: list[FlaggedQuestion] = Field(
        description="Questions the founder asked that presupposed the answer"
    )
    good_questions: list[str] = Field(
        description="Open-ended questions that surfaced real evidence"
    )
    current_alternative_mentioned: str | None = None
    willingness_to_pay_evidence: str | None = Field(
        default=None,
        description="What the founder actually established about willingness "
        "to pay/invest, based on real evidence in the transcript — not assumptions",
    )
    confidence: float = Field(
        ge=0, le=1, description="How much real signal this interview produced"
    )
    next_questions_to_ask: list[str]
    overall_verdict: str


class PersonaInsight(BaseModel):
    candidate_id: str
    persona_name: str
    persona_role: str
    persona_type: Literal["customer", "investor", "advisor"]
    insight: InterviewInsight


class AggregatedReport(BaseModel):
    persona_insights: list[PersonaInsight]
    cross_persona_synthesis: str | None = Field(
        default=None, description="Present only when 2+ personas were interviewed"
    )
