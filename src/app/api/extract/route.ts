import { NextResponse } from "next/server";
import https from "https";

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

    if (url.includes(".m3u8") || url.includes(".aac") || url.includes(".mp3")) {
       return NextResponse.json({ type: url.includes(".m3u8") ? "footage" : "music", url, title });
    }

    try {
      const text = await new Promise<string>((resolve, reject) => {
        const parsedUrl = new URL(url);
        const request = https.get({
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
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

      if (text) {
        const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
          const rawTitle = titleMatch[1].split(" - ")[0].split(" | ")[0].trim();
          if (rawTitle) title = rawTitle;
        }

        const mediaMatch = text.match(/(https:\/\/[^"'\s]+\.(?:m3u8|aac|mp3))/);
        if (mediaMatch) {
          const foundUrl = mediaMatch[0];
          return NextResponse.json({ type: foundUrl.includes(".m3u8") ? "footage" : "music", url: foundUrl, title });
        }

        const b64Matches = text.match(/Y29udGVudC9[a-zA-Z0-9+=/]+/g);
        if (b64Matches && b64Matches.length > 0) {
          for (const b64 of Array.from(new Set(b64Matches))) {
            try {
              const decoded = Buffer.from(b64, 'base64').toString('utf-8');
              if (decoded.includes('.aac') || decoded.includes('.mp3')) {
                const foundUrl = `https://cms-public-artifacts.artlist.io/${decoded}`;
                return NextResponse.json({ type: "music", url: foundUrl, title });
              }
            } catch (err) {}
          }
        }
      }
    } catch (e) {}

    return NextResponse.json({ error: "Mídia não encontrada no código-fonte. Verifique se o link está correto." }, { status: 404 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

