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
            <p className="text-xs text-muted-foreground">pre-filled when starting a new session</p>
          </div>
        </section>

        {/* Connection */}
        <section className="space-y-3">
          <div className="border-b border-border pb-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              connection
            </h2>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium">auto-connect on startup</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                automatically start a session with the main orchestrator when the app loads
              </p>
            </div>
            <button
              role="switch"
              aria-checked={settings.autoConnect}
              onClick={() => updateSettings({ autoConnect: !settings.autoConnect })}
              className={`relative shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 ${
                settings.autoConnect ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform ${
                  settings.autoConnect ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </section>

        {/* Agent Profiles */}
        <section className="space-y-3">
          <div className="border-b border-border pb-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              agent profiles
            </h2>
          </div>
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
                updateSettings({ agentProfiles: { ...settings.agentProfiles, main: e.target.value } })
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
        </section>

        {/* Shortcuts */}
        <section className="space-y-3">
          <div className="border-b border-border pb-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              keyboard shortcuts
            </h2>
          </div>
          <div className="space-y-2">
            {[
              { label: "new session", keys: "⌘N" },
              { label: "search sessions", keys: "⌘K" },
              { label: "open settings", keys: "⌘," },
            ].map(({ label, keys }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <kbd className="text-[11px] text-muted-foreground border border-border px-1.5 py-0.5">{keys}</kbd>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
