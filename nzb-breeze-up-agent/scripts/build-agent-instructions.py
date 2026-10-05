"""Regenerate docs/AGENT_INSTRUCTIONS.md (standard, pure Python) and
docs/AGENT_INSTRUCTIONS_EXACT.md (OR-Tools CP-SAT) from the copilot/ sources.

Copilot Studio agent instructions are limited to 8,000 characters, so this fails
loudly if the behaviour text plus the code grows past that.
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
for src, header, tpl, out in [
        ("breeze_up_scheduler.py", "instructions_header.txt", "agent_instructions_template.md", "AGENT_INSTRUCTIONS.md"),
        ("breeze_up_exact.py", "instructions_header_exact.txt", "agent_instructions_exact_template.md", "AGENT_INSTRUCTIONS_EXACT.md")]:
    code = (root / "copilot" / src).read_text().replace("F='INPUT.xlsx'", "F='<path of the uploaded workbook>'")
    full = (root / "copilot" / header).read_text() + code
    if len(full) > 8000:
        raise SystemExit(f"{out}: instructions are {len(full)} characters; Copilot Studio allows 8000.")
    doc = (root / "copilot" / tpl).read_text()
    (root / "docs" / out).write_text(doc.replace("{{CHARS}}", str(len(full))).replace("{{INSTRUCTIONS}}", full))
    print(f"docs/{out} written ({len(full)} characters)")
