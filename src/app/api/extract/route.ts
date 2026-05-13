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

    let htmlText = "";
    try {
      htmlText = await new Promise<string>((resolve, reject) => {
        const parsedUrl = new URL(url);
        const request = https.get({
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        
        request.on('error', reject);
        request.setTimeout(12000, () => {
          request.destroy();
          reject(new Error("Timeout"));
        });
      });
    } catch (e) {}

    // Fallback 1: curl nativo avançado
    if (!htmlText || htmlText.length < 80000) {
      try {
        const curlCmd = `curl -s -A "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1" -H "Accept-Language: en-US,en;q=0.9" --compressed "${url}"`;
        const { stdout } = await execAsync(curlCmd);
        if (stdout) htmlText = stdout;
      } catch (e) {}
    }

    // Fallback 2 Máximo: Oxylabs Web Scraper API (Garante acesso ao HTML estático contornando o Cloudflare no Render)
    if (!htmlText || htmlText.length < 80000) {
      try {
        const oxyAuth = Buffer.from("cadurec_Nc4pf:+Caduocara33").toString("base64");
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
        
        if (oxyRes.ok) {
          const oxyData = await oxyRes.json();
          if (oxyData.results && oxyData.results[0] && oxyData.results[0].content) {
            htmlText = oxyData.results[0].content;
          }
        }
      } catch (e) {}
    }

    if (htmlText) {
      const result = parseMediaFromHtml(htmlText, title);
      if (result) return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Mídia não encontrada no código-fonte estático. Verifique o link." }, { status: 404 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}




