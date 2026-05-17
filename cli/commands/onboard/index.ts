import {
  CliError,
  ok,
  lifecycle,
  prompts,
  loadConfigFileRaw,
  type CommandModule,
  type CommandContext,
} from "@belzabar/core";
import setupCommand from "../setup/index";
import webCommand from "../web/index";
import extensionCommand from "../extension/index";

// belz onboard — the guided first-run flow. It chains the focused commands
// (setup, extension load, web enable) behind confirm prompts, so it is safe to
// re-run: every step detects what is already done and offers to skip it.

type StepStatus = "done" | "skipped" | "failed";

interface OnboardStep {
  name: string;
  status: StepStatus;
  detail?: string;
}

interface OnboardData {
  steps: OnboardStep[];
}

/** Run a sub-command's execute() and reduce it to a step result. */
async function runStep(
  name: string,
  fn: () => Promise<unknown>
): Promise<OnboardStep> {
  try {
    await fn();
    return { name, status: "done" };
  } catch (err) {
    const message = err instanceof CliError ? err.message : String((err as Error)?.message ?? err);
    return { name, status: "failed", detail: message };
  }
}

const command: CommandModule<Record<string, never>, OnboardData> = {
  schema: "belz.onboard",

  parseArgs() {
    return {};
  },

  async execute(_args, context: CommandContext) {
    if (context.outputMode === "llm") {
      throw new CliError(
        "`belz onboard` is interactive. Use `belz setup --env-file`, `belz extension load`, " +
          "and `belz web enable` individually for non-interactive setup.",
        { code: "INTERACTIVE_NOT_SUPPORTED" }
      );
    }

    lifecycle.note(
      "Welcome to belz",
      "This will walk through credentials, the browser extension, and the web app.\n" +
        "It is safe to re-run any time — completed steps can be skipped."
    );

    const steps: OnboardStep[] = [];

    // ── 1. Credentials / environments ────────────────────────────────────────
    const existingEnvs = Object.keys(loadConfigFileRaw().environments ?? {}).length > 0;
    let configure = !existingEnvs;
    if (existingEnvs) {
      lifecycle.note("Credentials", "Environment credentials are already configured.");
      configure = await prompts.confirm({ message: "Reconfigure credentials?", initialValue: false });
    }
    if (configure) {
      steps.push(
        await runStep("Credentials", async () => {
          const args = await setupCommand.parseArgs!(existingEnvs ? ["--force"] : [], context);
          const res = await setupCommand.execute(args, context);
          if (!res.ok) throw new CliError(res.error?.message ?? "setup failed", { code: "SETUP_FAILED" });
        })
      );
    } else {
      steps.push({ name: "Credentials", status: "skipped", detail: "already configured" });
    }

    // ── 2. Browser extension (optional — still being finished) ───────────────
    const doExtension = await prompts.confirm({
      message: "Install the Belzabar browser extension now? (optional, experimental)",
      initialValue: false,
    });
    if (doExtension) {
      steps.push(
        await runStep("Browser extension", async () => {
          const res = await extensionCommand.execute(
            { action: "load", browsers: [], all: false },
            context
          );
          if (!res.ok) throw new CliError(res.error?.message ?? "extension load failed", { code: "EXT_FAILED" });
        })
      );
    } else {
      steps.push({ name: "Browser extension", status: "skipped" });
    }

    // ── 3. Web app autostart ─────────────────────────────────────────────────
    const doWeb = await prompts.confirm({
      message: "Start the Belzabar web app automatically at login?",
      initialValue: true,
    });
    if (doWeb) {
      steps.push(
        await runStep("Web autostart", async () => {
          const res = await webCommand.execute({ action: "enable", verbose: false }, context);
          if (!res.ok) throw new CliError(res.error?.message ?? "web enable failed", { code: "WEB_FAILED" });
        })
      );
    } else {
      steps.push({ name: "Web autostart", status: "skipped" });
    }

    lifecycle.outro("Onboarding complete.");
    return ok<OnboardData>({ steps });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as OnboardData;
    const icon = (s: StepStatus) => (s === "done" ? "✓" : s === "skipped" ? "–" : "✗");
    ui.section("Onboarding summary");
    for (const step of data.steps) {
      const line = `${icon(step.status)} ${step.name}${step.detail ? ` — ${step.detail}` : ""}`;
      if (step.status === "failed") ui.warn(line);
      else ui.text(line);
    }
    if (data.steps.some((s) => s.status === "failed")) {
      ui.text("");
      ui.text("Some steps failed — re-run `belz onboard` or the individual command to retry.");
    }
  },
};

export default command;
