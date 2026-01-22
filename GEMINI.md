# Gemini CLI Integration

You are interacting with the **Automation Designer (AD)** via the `belzabar-cli`.

## What is this?
A CLI tool to inspect and debug automation methods. You have **read-only** access to definitions and **execution** access to Draft methods.

## Your Tools
You have access to MCP tools or raw shell commands:

1.  `ad.show_method(uuid)`: Get JSON definition of a method.
2.  `ad.test_method(uuid, inputs)`: Run a method and get a JSON trace.

## Expectations
*   **Always** inspect a method (`show_method`) before running it.
*   **Never** guess input fields. Read them from the definition.
*   **Report** root causes of failures by analyzing the execution trace.
*   **Do not** attempt to edit files or code. You are an observer/debugger.

## Output Handling
The CLI supports `--llm`. **Always** use this flag. It returns deterministic JSON.
Do not read the "human" output (tables/colors).
