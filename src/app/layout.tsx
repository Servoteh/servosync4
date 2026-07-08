import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { QueryProvider } from "@/api/query-provider";
import { AuthProvider } from "@/lib/auth-context";

export const metadata: Metadata = {
  title: "ServoSync",
  description: "ServoSync — sinhronizacija podataka iz QBigTehn",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="sr" className="h-full">
      <body className="min-h-full flex flex-col bg-app text-ink">
        {/* Opcioni runtime override za API base URL (LAN/offline) — vidi public/config.js.
            beforeInteractive: izvrši se pre app koda, pa je override spreman pre prvog fetch-a. */}
        <Script src="/config.js" strategy="beforeInteractive" />
        <QueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
