import type { Metadata } from "next";
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
        <QueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
