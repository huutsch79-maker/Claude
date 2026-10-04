"""Regenerate docs/AGENT_INSTRUCTIONS.md from copilot/breeze_up_scheduler.py.

Copilot Studio agent instructions are limited to 8,000 characters, so this fails
loudly if the behaviour text plus the code grows past that.
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
code = (root / "copilot/breeze_up_scheduler.py").read_text().replace("F='INPUT.xlsx'", "F='<path of the uploaded workbook>'")
head = (root / "copilot/instructions_header.txt").read_text()
full = head + code
if len(full) > 8000:
    raise SystemExit(f"Instructions are {len(full)} characters; Copilot Studio allows 8000.")
doc = (root / "copilot/agent_instructions_template.md").read_text()
(root / "docs/AGENT_INSTRUCTIONS.md").write_text(doc.replace("{{CHARS}}", str(len(full))).replace("{{INSTRUCTIONS}}", full))
print(f"docs/AGENT_INSTRUCTIONS.md written ({len(full)} characters)")
