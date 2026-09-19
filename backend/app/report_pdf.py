from fpdf import FPDF
from fpdf.enums import XPos, YPos

from .models import AggregatedReport, ProductBrief

_SANITIZE_MAP = {
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ",
    "•": "-",
}


def _clean(text: str | None) -> str:
    if not text:
        return ""
    for src, dst in _SANITIZE_MAP.items():
        text = text.replace(src, dst)
    return text.encode("latin-1", errors="replace").decode("latin-1")


class _ReportPDF(FPDF):
    def header(self):
        pass

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(140, 140, 140)
        self.cell(0, 8, f"Page {self.page_no()}", align="C")


_MC = dict(new_x=XPos.LMARGIN, new_y=YPos.NEXT)


def _h1(pdf: _ReportPDF, text: str):
    pdf.set_font("Helvetica", "B", 18)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(0, 9, _clean(text), **_MC)
    pdf.ln(2)


def _h2(pdf: _ReportPDF, text: str):
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(0, 8, _clean(text), **_MC)
    pdf.ln(1)


def _h3(pdf: _ReportPDF, text: str):
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(40, 40, 40)
    pdf.multi_cell(0, 7, _clean(text), **_MC)


def _body(pdf: _ReportPDF, text: str):
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(60, 60, 60)
    pdf.multi_cell(0, 6, _clean(text), **_MC)


def _bullet(pdf: _ReportPDF, text: str):
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(60, 60, 60)
    pdf.multi_cell(0, 6, f"- {_clean(text)}", **_MC)


_TYPE_LABEL = {"customer": "Customer", "investor": "Investor", "advisor": "Advisor"}
_CONCERNS_LABEL = {
    "customer": "Pain points",
    "investor": "Investment concerns",
    "advisor": "Critiques & concerns raised",
}
_COMMITMENT_LABEL = {
    "customer": "Willingness to pay - what you actually established",
    "investor": "Investment commitment - what you actually established",
    "advisor": "Advisor's overall verdict",
}


def build_report_pdf(brief: ProductBrief, report: AggregatedReport) -> bytes:
    pdf = _ReportPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    _h1(pdf, "Customer Mirror - Interview Report")
    _body(pdf, f"Product: {brief.product_description}")
    _body(pdf, f"Target customer: {brief.target_customer}")
    _body(pdf, f"Hypothesis: {brief.key_hypothesis}")
    pdf.ln(4)

    for pi in report.persona_insights:
        pdf.add_page()
        type_label = _TYPE_LABEL[pi.persona_type]
        _h2(pdf, f"{pi.persona_name} - {pi.persona_role} ({type_label})")
        if pi.persona_type == "advisor":
            pdf.set_font("Helvetica", "I", 9)
            pdf.set_text_color(140, 140, 140)
            pdf.multi_cell(0, 5, "AI simulation based on public interviews/writing - not verified or endorsed by the real person.", **_MC)
            pdf.ln(1)

        insight = pi.insight
        _body(pdf, f"Signal confidence: {round(insight.confidence * 100)}%")
        pdf.ln(2)

        _h3(pdf, _CONCERNS_LABEL[pi.persona_type])
        if insight.discovered_pain_points:
            for p in insight.discovered_pain_points:
                _bullet(pdf, f"{p.description} (severity {p.severity_guess}/10)")
                if p.supporting_quote:
                    pdf.set_font("Helvetica", "I", 9)
                    pdf.set_text_color(110, 110, 110)
                    pdf.multi_cell(0, 5, f'  "{_clean(p.supporting_quote)}"', **_MC)
        else:
            _body(pdf, "None confirmed in this interview.")
        pdf.ln(2)

        _h3(pdf, "Leading/hypothetical questions to avoid next time")
        if insight.leading_questions:
            for q in insight.leading_questions:
                _bullet(pdf, f'"{q.question}" - {q.reason}')
        else:
            _body(pdf, "None flagged.")
        pdf.ln(2)

        _h3(pdf, "Questions that worked")
        if insight.good_questions:
            for q in insight.good_questions:
                _bullet(pdf, q)
        else:
            _body(pdf, "None recorded.")
        pdf.ln(2)

        _h3(pdf, _COMMITMENT_LABEL[pi.persona_type])
        _body(pdf, insight.willingness_to_pay_evidence or "Not established in this interview.")
        pdf.ln(2)

        _h3(pdf, "Verdict")
        _body(pdf, insight.overall_verdict)
        pdf.ln(2)

        _h3(pdf, "Ask next time")
        for q in insight.next_questions_to_ask:
            _bullet(pdf, q)

    if report.cross_persona_synthesis:
        pdf.add_page()
        _h2(pdf, "Across all interviews")
        _body(pdf, report.cross_persona_synthesis)

    return bytes(pdf.output())
