import { NextResponse } from "next/server";
import https from "https";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

function parseMediaFromHtml(text: string, defaultTitle: string) {
  let title = defaultTitle;
  const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const rawTitle = titleMatch[1].split(" - ")[0].split(" | ")[0].trim();
    if (rawTitle) title = rawTitle;
  }

  // Busca links diretos visíveis
  const mediaMatch = text.match(/(https:\/\/[^"'\s]+\.(?:m3u8|aac|mp3|mp4))/);
  if (mediaMatch) {
    const foundUrl = mediaMatch[0];
    const isFootage = foundUrl.includes(".m3u8") || foundUrl.includes(".mp4");
    return { type: isFootage ? "footage" : "music", url: foundUrl, title };
  }

  // Busca links ocultos em Base64 (Músicas e Vídeos que começam com 'content/')
  const b64Matches = text.match(/Y29udGVudC9[a-zA-Z0-9+=/]+/g);
  if (b64Matches && b64Matches.length > 0) {
    for (const b64 of Array.from(new Set(b64Matches))) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        if (decoded.includes('.aac') || decoded.includes('.mp3') || decoded.includes('.m3u8') || decoded.includes('.mp4')) {
          const foundUrl = `https://cms-public-artifacts.artlist.io/${decoded}`;
          const isFootage = decoded.includes('.m3u8') || decoded.includes('.mp4');
          return { type: isFootage ? "footage" : "music", url: foundUrl, title };
        }
      } catch (err) {}
    }
  }

  // Tenta buscar por caminhos parciais do CDN no formato JSON escapado
  const cdnMatch = text.match(/cms-public-artifacts\.artlist\.io[^\s"'\\]+?\.(?:aac|mp3|m3u8|mp4)/i);
  if (cdnMatch) {
    const foundUrl = `https://${cdnMatch[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/")}`;
    const isFootage = foundUrl.includes(".m3u8") || foundUrl.includes(".mp4");
    return { type: isFootage ? "footage" : "music", url: foundUrl, title };
  }

  // Busca super abrangente solicitada pelo usuário: qualquer menção a .m3u ou .m3u8 no texto (com ou sem protocolo)
  const broadM3uMatch = text.match(/[a-zA-Z0-9_.\-/\\:]+?\.m3u8?/i);
  if (broadM3uMatch) {
    let clean = broadM3uMatch[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/\\/g, "");
    if (!clean.startsWith("http")) {
      clean = clean.replace(/^\/+/, "");
      if (!clean.includes("content/")) {
        clean = `content/artgrid/footage-hls/${clean}`;
      }
      clean = `https://cms-public-artifacts.artlist.io/${clean}`;
    }
    return { type: "footage", url: clean, title };
  }

  // Busca super abrangente para músicas/áudio: qualquer menção a .mp3 ou .aac
  const broadAudioMatch = text.match(/[a-zA-Z0-9_.\-/\\:]+?\.(?:mp3|aac)/i);
  if (broadAudioMatch) {
    let clean = broadAudioMatch[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/\\/g, "");
    if (!clean.startsWith("http")) {
      clean = clean.replace(/^\/+/, "");
      if (!clean.includes("content/")) {
        clean = `content/${clean}`;
      }
      clean = `https://cms-public-artifacts.artlist.io/${clean}`;
    }
    return { type: "music", url: clean, title };
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "A URL é obrigatória." }, { status: 400 });

    let title = "artlist_media";
    try {
      const cleanUrl = url.split("?")[0].replace(/\/$/, "");
      const parts = cleanUrl.split("/");
      if (parts.length >= 2) {
        if (/^\d+$/.test(parts[parts.length - 1])) {
          title = parts[parts.length - 2];
        } else {
          const last = parts[parts.length - 1];
          if (!["clip", "song", "track", "sfx"].includes(last)) {
            title = last;
          }
        }
      }
    } catch (e) {}

    if (url.includes(".m3u8") || url.includes(".aac") || url.includes(".mp3") || url.includes(".mp4")) {
       const isFootage = url.includes(".m3u8") || url.includes(".mp4");
       return NextResponse.json({ type: isFootage ? "footage" : "music", url, title });
    }

    let extractedMedia: any = null;
    let fastOk = false;
    let htmlLen = 0;
    let oxyStatus = 0;
    
    // 1. TENTATIVA DIRETA ULTRA RÁPIDA (Vercel / Localhost):
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const fastRes = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5"
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      fastOk = fastRes.ok;
      if (fastRes.ok) {
        const text = await fastRes.text();
        htmlLen = text.length;
        if (!text.includes("Just a moment...") && !text.includes("cf-turnstile") && text.includes("artlist")) {
          extractedMedia = parseMediaFromHtml(text, title);
          if (extractedMedia) {
            return NextResponse.json(extractedMedia);
          }
        }
      }
    } catch (e) {}

    // 2. PLANO B DE EMERGÊNCIA (API Oxylabs):
    if (!extractedMedia) {
      try {
        const authStr = process.env.OXYLABS_AUTH || "cadurec_Nc4pf:+Caduocara33";
        const oxyAuth = Buffer.from(authStr).toString("base64");
        const oxyRes = await fetch("https://realtime.oxylabs.io/v1/queries", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${oxyAuth}`
          },
          body: JSON.stringify({
            source: "universal",
            url: url
          })
        });
        
        oxyStatus = oxyRes.status;
        if (oxyRes.ok) {
          const oxyData = await oxyRes.json();
          if (oxyData.results && oxyData.results[0] && oxyData.results[0].content) {
            htmlLen = oxyData.results[0].content.length;
            extractedMedia = parseMediaFromHtml(oxyData.results[0].content, title);
            if (extractedMedia) {
              return NextResponse.json(extractedMedia);
            }
          }
        }
      } catch (e) {}
    }

    return NextResponse.json({ 
      error: `Mídia não encontrada. (Debug: FastOk=${fastOk}, Len=${htmlLen}, OxyStatus=${oxyStatus})` 
    }, { status: 404 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}




