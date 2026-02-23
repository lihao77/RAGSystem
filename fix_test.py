#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Fix test_agent_upgrade.py to use Event objects
"""

import re

# Read the file
with open('test_agent_upgrade.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix import
content = content.replace(
    'from agents.events import EventBus, EventType',
    'from agents.events import EventBus, EventType, Event'
)

# Fix event publishing - replace all event_bus.publish calls
old_pattern = r'event_bus\.publish\(EventType\.(\w+),\s*\{([^}]+)\}\)'

def replace_publish(match):
    event_type = match.group(1)
    data_content = match.group(2)
    return f'''event_bus.publish(Event(
            type=EventType.{event_type},
            agent_name="test_agent",
            data={{{data_content}}}
        ))'''

content = re.sub(old_pattern, replace_publish, content, flags=re.DOTALL)

# Write back
with open('test_agent_upgrade.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ Fixed test_agent_upgrade.py")
