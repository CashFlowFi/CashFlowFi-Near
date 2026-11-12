import type { Metadata } from "next";
import { Geist, IBM_Plex_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { Ambient } from "@/components/Ambient";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { ReturnedResults } from "@/components/actions/TxResultView";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const plex = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: { default: "Cashflow Fi", template: "%s · Cashflow Fi" },
  description: "Merchant receivables financing on NEAR, with tranches, an AI underwriter and DAO-governed insurance.",
};

// Runs before paint so the saved or system theme never flashes.
const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${geist.variable} ${plex.variable} relative flex min-h-dvh flex-col overflow-x-clip font-sans antialiased`}>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:bg-surface focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Ambient />
        <WalletProvider>
          <Nav />
          <main id="main" className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-8 sm:px-6 sm:pt-10">
            <ReturnedResults />
            {children}
          </main>
          <Footer />
        </WalletProvider>
      </body>
    </html>
  );
}
