import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Sidebar } from "@/components/Sidebar";
import { getDb } from "@/lib/db";
import { chainHead } from "@/lib/reports";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  title: "Ledgerline · Inventory ledger",
  description: "Append-only inventory ledger with auditable financial reporting.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const head = chainHead(getDb());
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">
        <div className="lg:flex">
          <Sidebar head={head} />
          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-7xl px-4 py-7 sm:px-8 sm:py-10">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
