import {
  CliError,
  defineArgs,
  failWithData,
  ok,
  lifecycle,
  prompts,
  loadConfigFileRaw,
  type CommandModule,
  type CommandContext,
} from "@belzabar/core";
import setupCommand from "../setup/index";

// belz onboard — the guided first-run flow. It chains the focused commands
// (currently `belz setup`) behind confirm prompts, so it is safe to
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

/**
 * Run a sub-command's execute() and reduce it to a step result. A Ctrl-C
 * (USER_ABORT) is re-thrown: it ends onboarding (exit 130) instead of being
 * recorded as a failed step and carrying on to the next prompt.
 */
export async function runStep(
  name: string,
  fn: () => Promise<unknown>
): Promise<OnboardStep> {
  try {
    await fn();
    return { name, status: "done" };
  } catch (err) {
    if (err instanceof CliError && err.code === "USER_ABORT") throw err;
    const message = err instanceof CliError ? err.message : String((err as Error)?.message ?? err);
    return { name, status: "failed", detail: message };
  }
}

/**
 * The command result: ok only when no step failed. A failed step used to be
 * reported with exit 0, so install.sh's `if ! belz onboard` treated a broken
 * setup as success.
 */
export function finishOnboard(steps: OnboardStep[]) {
  const failed = steps.filter((s) => s.status === "failed");
  if (failed.length > 0) {
    return failWithData<OnboardData>(
      "ONBOARD_INCOMPLETE",
      `Onboarding incomplete: ${failed.map((s) => s.name).join(", ")} failed.`,
      { steps },
    );
  }
  lifecycle.outro("Onboarding complete.");
  return ok<OnboardData>({ steps });
}

export const args = defineArgs({ command: "belz onboard" });

const command: CommandModule<Record<string, never>, OnboardData> = {

  /** Writes ~/.belz/config.json (via setup). */
  writesLocal: true,
  parseArgs(argv) {
    args.parse(argv);
    return {};
  },

  async execute(_args, context: CommandContext) {
    if (context.outputMode === "llm") {
      throw new CliError(
        "`belz onboard` is interactive. Use `belz setup --env-file` for non-interactive setup.",
        { code: "INTERACTIVE_NOT_SUPPORTED" }
      );
    }

    lifecycle.note(
      "Welcome to belz",
      "This will walk through environment credentials.\n" +
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

    return finishOnboard(steps);
  },

  presentHuman(envelope, ui) {
    if (!envelope.data) return;
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
