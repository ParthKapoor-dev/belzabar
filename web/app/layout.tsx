import type { Metadata } from "next"
import { Geist } from "next/font/google"
import localFont from "next/font/local"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Belzabar",
}

const fontSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
})

// IoskeleyMono — an OFL-licensed, Berkeley-Mono-style monospace (see app/fonts/).
// The theme stack in globals.css prefers a real "Berkeley Mono" if installed and
// falls back to this bundled face otherwise.
const fontMono = localFont({
  variable: "--font-iosk",
  display: "swap",
  src: [
    { path: "./fonts/IoskeleyMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IoskeleyMono-Italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/IoskeleyMono-Bold.woff2", weight: "700", style: "normal" },
    { path: "./fonts/IoskeleyMono-BoldItalic.woff2", weight: "700", style: "italic" },
  ],
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontSans.variable, "font-mono", fontMono.variable)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
