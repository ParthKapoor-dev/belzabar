"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"

export function ConfirmDeleteModal({
  open,
  sessionName,
  onConfirm,
  onCancel,
}: {
  open: boolean
  sessionName: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="border border-border bg-background p-5 space-y-4 max-w-xs w-full mx-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-medium">delete session?</p>
        <p className="text-xs text-muted-foreground truncate">{sessionName}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="destructive" onClick={onConfirm} className="flex-1">
            delete
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel} className="flex-1">
            cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
