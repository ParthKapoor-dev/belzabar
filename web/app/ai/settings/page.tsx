"use client"

import { useSessionsContext } from "@/lib/sessions-context"
import { AGENT_REGISTRY } from "@/lib/acp-types"

const AGENT_OPTIONS = Object.keys(AGENT_REGISTRY)

export default function SettingsPage() {
  const { settings, updateSettings } = useSessionsContext()

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-6 py-8 space-y-8">
        <div>
          <h1 className="text-sm font-medium">settings</h1>
          <p className="mt-1 text-xs text-muted-foreground">configure your coding agent environment</p>
        </div>

        {/* Working Directory */}
        <section className="space-y-3">
          <div className="border-b border-border pb-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              working directory
            </h2>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">default working directory</label>
            <input
              type="text"
              value={settings.defaultCwd}
              onChange={(e) => updateSettings({ defaultCwd: e.target.value })}
              placeholder="/path/to/project"
              className="w-full border border-border bg-transparent px-2.5 py-1.5 text-xs placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              pre-filled when starting a new session
            </p>
          </div>
        </section>

        {/* Agent Profiles */}
        <section className="space-y-3">
          <div className="border-b border-border pb-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              agent profiles
            </h2>
          </div>

          <div className="space-y-4">
            {/* Main Orchestrator */}
            <div className="space-y-1.5">
              <div>
                <p className="text-xs font-medium">main orchestrator</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  primary agent used for all sessions
                </p>
              </div>
              <select
                value={settings.agentProfiles.main}
                onChange={(e) =>
                  updateSettings({
                    agentProfiles: { ...settings.agentProfiles, main: e.target.value },
                  })
                }
                className="border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring/50 uppercase"
              >
                {AGENT_OPTIONS.map((name) => (
                  <option key={name} value={name} className="bg-background text-foreground">
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
