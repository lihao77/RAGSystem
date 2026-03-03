"""修复 react/agent.py 和 master/agent.py 中的中文引号"""
import os

files_to_fix = [
    'agents/implementations/react/agent.py',
    'agents/implementations/master/agent.py',
]

for filepath in files_to_fix:
    if not os.path.exists(filepath):
        print(f"SKIP: {filepath} not found")
        continue

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    left_q = content.count('\u201c')   # "
    right_q = content.count('\u201d')  # "
    total = left_q + right_q

    if total == 0:
        print(f"OK: {filepath} - no curly quotes found")
        continue

    content = content.replace('\u201c', '"').replace('\u201d', '"')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"FIXED: {filepath} - replaced {total} curly quotes")

print("Done.")
