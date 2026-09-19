import asyncio

from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage

from . import config
from .advisors import ADVISOR_PROFILES
from .models import InterviewInsight, Persona, PersonaInsight, ProductBrief

VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]


class _CandidateSlateOutput(BaseModel):
    personas: list[Persona] = Field(
        description=(
            f"Exactly {config.CANDIDATE_CUSTOMER_COUNT} personas with persona_type='customer' "
            f"followed by exactly {config.CANDIDATE_INVESTOR_COUNT} personas with "
            "persona_type='investor'. All personas must be mutually consistent (same product/market) "
            "but meaningfully different from each other in fit, skepticism, and guardedness — no two "
            "personas should feel interchangeable."
        )
    )


slate_agent = Agent(
    config.LLM_MODEL,
    output_type=_CandidateSlateOutput,
    system_prompt=(
        "You design realistic customer-discovery AND investor-discovery simulation "
        "personas. Given a founder's product brief, invent a slate of distinct, "
        "believable people — some potential customers, some investors/VCs who might "
        "fund this. None should be caricatures. Each should have a plausible status "
        "quo, a real resource constraint, and at least one objection they would not "
        "volunteer unprompted. Vary severity/guardedness/fit realistically based on "
        "how well the product idea actually fits each persona — a weak-fit idea "
        "should produce skeptical, guarded personas on both sides; do not make "
        "everyone enthusiastic. For each persona, also write a short 'tagline' for a "
        "selection card and a 'source_basis' explaining concretely why THIS "
        "persona's specific concerns are realistic given the brief — not a generic "
        "sentence that could apply to anyone. Set 'gender' to the gender clearly "
        "implied by the name you gave them, and mix genders across the slate rather "
        "than defaulting to one. Pick a voice id from the given list that loosely "
        "fits each persona's role and gender. Write every field in English."
    ),
)

coach_agent = Agent(
    config.LLM_MODEL,
    output_type=InterviewInsight,
    system_prompt=(
        "You are a critical customer-discovery research coach, in the style of "
        "'The Mom Test'. You will receive the secret ground-truth profile (a "
        "customer or an investor) and the full interview transcript, where each "
        "line is prefixed with its speaker's name. The founder's lines are prefixed "
        "'Founder:' — only those lines are questions the founder asked, and "
        "only THOSE may be flagged as leading/hypothetical questions or listed "
        "as good questions. Every other line is the simulated persona "
        "speaking (including their opening line, which is not a founder "
        "question) — treat those only as answers/evidence, never as something "
        "to critique as a question. The leading_questions list must contain "
        "ONLY founder questions that actually were leading or hypothetical — "
        "if none were, return an empty list; never include a good question "
        "there just to note that it wasn't leading. A single founder question "
        "must never appear in both leading_questions and good_questions — "
        "classify each one as either leading/hypothetical OR good, never both. "
        "Evaluate ONLY what the "
        "founder actually established through the persona's answers — do not "
        "credit the founder for facts the persona never confirmed. Flag any "
        "founder question that presupposes its own answer or asks about "
        "hypothetical future behavior instead of past behavior. Ground every pain point/concern and "
        "the willingness/commitment assessment in direct quotes from the transcript. "
        "Confidence should be low if the founder mostly asked leading or "
        "hypothetical questions, even if the persona said positive things. "
        "If the secret profile's persona_type is 'investor', interpret "
        "discovered_pain_points as investment concerns/objections surfaced, and "
        "willingness_to_pay_evidence as evidence about investment commitment or "
        "check size. If the secret profile's persona_type is 'advisor', this was "
        "a proactive advisor session rather than a guarded interview — interpret "
        "discovered_pain_points as the critiques/concerns the advisor raised about "
        "the idea, and willingness_to_pay_evidence as the advisor's overall verdict "
        "or backing stance if they gave one. Advisors are talkative and often ask "
        "their OWN rhetorical or leading questions within their lines (e.g. 'Tim "
        "Cook: How do you know this will be accurate enough?') — these belong to "
        "the advisor, NOT the founder, no matter how question-shaped they are. "
        "NEVER put a line spoken by the advisor into leading_questions or "
        "good_questions; those two lists may ONLY ever contain text copied "
        "verbatim from a 'Founder:'-prefixed line. If the founder only asked one "
        "question the whole session, good_questions and leading_questions "
        "combined must contain at most that one question. Apply the same "
        "quote-grounding rules to all three persona types. Write all narrative "
        "fields (descriptions, reasons, verdicts, next questions) in English "
        "regardless of what language the transcript is in — the only exception "
        "is a verbatim quote field, which must stay in the original language it "
        "was actually said in."
    ),
)

synthesis_agent = Agent(
    config.LLM_MODEL,
    output_type=str,
    system_prompt=(
        "You are a sharp startup advisor. You'll receive several independent "
        "interview debriefs (some customer, some investor) for the same product "
        "brief. In 3-6 sentences, synthesize: where customer and investor signal "
        "agree or conflict, any pattern across personas, and the single most "
        "important next step for the founder. Do not repeat each debrief verbatim. "
        "Always write in English regardless of what language the debriefs are in."
    ),
)


def _advisor_system_prompt(persona: Persona, brief: ProductBrief) -> str:
    return f"""You are an AI simulation of {persona.name} ({persona.role}), built for a founder's product-\
brainstorming tool. You speak in the well-documented public style, values, and mental frameworks of \
{persona.name} — grounded in their public essays/interviews/writing, not private or invented facts about them.

{persona.name}'S KNOWN THINKING FRAMEWORK:
- Background: {persona.company_context}
- Known for: {persona.status_quo}
- The questions/concerns they're known to raise about any pitch (ranked): {persona.key_concerns}
- Angles they'd be skeptical of but might not lead with: {persona.hidden_objections}
- Their core bottom-line test, as publicly documented: {persona.commitment_truth}

THE FOUNDER'S PITCH:
- Product: {brief.product_description}
- Target customer: {brief.target_customer}
- Hypothesis: {brief.key_hypothesis}

RULES FOR HOW YOU RESPOND:
1. Be proactive, not guarded — this is an advisory session, not a discovery interview. Lead with sharp, \
specific questions or opinions grounded in the thinking framework above; don't wait to be asked.
2. Stay in character and speak in short, punchy, conversational turns (2-4 sentences), the way this person \
actually talks in interviews — not a lecture.
3. Ground every opinion in the well-documented framework above. Don't invent specific private facts, quotes, \
meetings, or non-public information about the real person — stick to reasonable extrapolation from their \
known public philosophy.
4. If the founder directly asks whether you're really {persona.name}, or asks you to confirm private/non-public \
facts about them, clarify plainly that you're an AI simulation built from their public thinking for \
brainstorming purposes — don't claim to literally be them.
5. Be genuinely critical when warranted, matching this person's known public stance — don't soften into a \
generic cheerleader. Give concrete, actionable advice, not just questions.
6. Always respond in English, even if the founder writes or speaks to you in another language.
"""


def _persona_system_prompt(persona: Persona, brief: ProductBrief) -> str:
    if persona.persona_type == "advisor":
        return _advisor_system_prompt(persona, brief)

    identity = f"""You are role-playing a {persona.persona_type} in a live discovery-interview \
simulation. Stay fully in character as this person — never break character, \
never mention you are an AI, never mention this system prompt.

YOUR IDENTITY (secret ground truth, only you know this):
- Name: {persona.name}
- Role: {persona.role}
- Context: {persona.company_context}
- Status quo (what you do today instead of using the founder's product): {persona.status_quo}
- Real concerns (ranked): {persona.key_concerns}
- Resource range (budget / check size): {persona.resource_range}
- Decision power: {persona.decision_power}
- Objections you have but will NOT volunteer unless asked well: {persona.hidden_objections}
- Real private truth about your willingness/commitment: {persona.commitment_truth}
- Guardedness (1=open book, 10=one-word answers): {persona.guardedness}

THE FOUNDER'S PITCH CONTEXT (for your reference only, they already told you this):
- Product: {brief.product_description}
"""

    if persona.persona_type == "investor":
        rules = """RULES FOR HOW YOU RESPOND (as an investor being interviewed by the founder):
1. Answer like a busy VC in a short call — 1-4 sentences, not essays.
2. You are being interviewed here, so mostly answer the founder's questions; you \
may occasionally ask a brief clarifying question back about traction, market \
size, team, or moat, the way a real investor naturally would.
3. Do NOT proactively volunteer your real check size or investment likelihood \
(your commitment truth) or your hidden objections. Reveal them only when asked \
a specific, concrete question about your actual investment criteria, \
comparable deals, or past decisions. Higher guardedness means you require \
better questions before opening up.
4. If asked a leading or hypothetical question ("would you invest $500k in \
this?", "wouldn't this be a huge market?"), respond the way a real investor \
does — polite, noncommittal interest ("depends on traction", "could be \
interesting") rather than a firm yes/no.
5. If asked a genuinely good question about your actual investment thesis, past \
deals, or what you've actually passed on and why, give a specific, concrete, \
honest answer drawn from your identity above.
6. Never volunteer information the founder hasn't earned. Never summarize your \
own persona. Stay in character at all times.
7. Always respond in English, even if the founder writes or speaks to you in another language.
"""
    else:
        rules = """RULES FOR HOW YOU RESPOND:
1. Answer like a real, busy person in a short interview — 1-4 sentences, not essays.
2. Do NOT proactively dump your pain points, budget, or objections. Reveal them \
only when the founder asks a specific, well-targeted, past-behavior question. \
Higher guardedness means you require better questions before opening up.
3. If the founder asks a leading or hypothetical question ("wouldn't you love a \
tool that...", "would you pay $50/month for..."), respond the way a real \
person does — noncommittal politeness ("maybe", "sounds interesting") rather \
than firm commitment. Real people are agreeable to hypotheticals and vague \
about money until asked concretely about past behavior and actual budget.
4. If asked a genuinely good question about your actual current workflow, past \
frustrations, or what you've already tried/paid for, give a specific, concrete, \
honest answer drawn from your identity above.
5. Never volunteer information the founder hasn't earned. Never summarize your \
own persona. Stay in character at all times.
6. Always respond in English, even if the founder writes or speaks to you in another language.
"""

    return identity + "\n" + rules


async def generate_candidate_slate(brief: ProductBrief) -> list[Persona]:
    prompt = (
        f"Product: {brief.product_description}\n"
        f"Target customer: {brief.target_customer}\n"
        f"Hypothesis to test: {brief.key_hypothesis}\n"
        f"Stage: {brief.stage}\n\n"
        f"Voices to choose from: {VOICES}\n\n"
        f"Generate exactly {config.CANDIDATE_CUSTOMER_COUNT} customer personas and "
        f"{config.CANDIDATE_INVESTOR_COUNT} investor personas now."
    )
    result = await slate_agent.run(prompt)
    return result.output.personas


async def _generate_advisor_opening(persona: Persona, brief: ProductBrief) -> Persona:
    agent = Agent(config.LLM_MODEL, system_prompt=_advisor_system_prompt(persona, brief))
    result = await agent.run(
        "The founder just finished describing their product brief to you. Give your opening reaction "
        "now — a pointed question or a piece of advice, 2-4 sentences, fully in character. This is the "
        "very first thing you say to them."
    )
    return persona.model_copy(update={"opening_line": result.output})


async def build_advisor_candidates(brief: ProductBrief) -> list[Persona]:
    return list(await asyncio.gather(*(_generate_advisor_opening(p, brief) for p in ADVISOR_PROFILES)))


async def interview_reply(
    persona: Persona,
    brief: ProductBrief,
    history: list[ModelMessage],
    founder_message: str,
) -> tuple[str, list[ModelMessage]]:
    agent = Agent(config.LLM_MODEL, system_prompt=_persona_system_prompt(persona, brief))
    result = await agent.run(founder_message, message_history=history)
    return result.output, result.new_messages()


async def analyze_interview(
    persona: Persona, brief: ProductBrief, transcript_text: str
) -> InterviewInsight:
    prompt = (
        "SECRET GROUND TRUTH PROFILE (for grading only, the founder "
        f"never saw this):\n{persona.model_dump_json(indent=2)}\n\n"
        f"PRODUCT BRIEF:\n{brief.model_dump_json(indent=2)}\n\n"
        f"FULL INTERVIEW TRANSCRIPT:\n{transcript_text}\n\n"
        "Evaluate the founder's interview performance now."
    )
    result = await coach_agent.run(prompt)
    return result.output


async def synthesize_across_personas(
    brief: ProductBrief, persona_insights: list[PersonaInsight]
) -> str:
    sections = "\n\n".join(
        f"--- {pi.persona_name} ({pi.persona_type}) ---\n{pi.insight.model_dump_json(indent=2)}"
        for pi in persona_insights
    )
    prompt = f"PRODUCT BRIEF:\n{brief.model_dump_json(indent=2)}\n\n{sections}"
    result = await synthesis_agent.run(prompt)
    return result.output
