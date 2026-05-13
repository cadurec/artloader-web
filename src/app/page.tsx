"use client";

import { useState, useRef, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { Download, Loader2, Play, CheckCircle, AlertCircle, FileVideo, FileAudio } from "lucide-react";

type AppState = "idle" | "extracting" | "selecting_quality" | "downloading" | "processing" | "done" | "error";

interface Quality {
  name: string;
  url: string;
  resolution?: string;
  format?: "mp3" | "wav" | "original";
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [appState, setAppState] = useState<AppState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [progressText, setProgressText] = useState("");
  const [progressPercent, setProgressPercent] = useState(0);
  
  const [mediaType, setMediaType] = useState<"footage" | "music" | null>(null);
  const [mediaTitle, setMediaTitle] = useState<string>("artlist_media");
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [selectedQuality, setSelectedQuality] = useState<Quality | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState<string>("");

  const ffmpegRef = useRef<any>(null);
  const [isFfmpegLoaded, setIsFfmpegLoaded] = useState(false);

  useEffect(() => {
    // Only instantiate FFmpeg on the client side
    if (!ffmpegRef.current) {
      ffmpegRef.current = new FFmpeg();
    }
    loadFfmpeg();
  }, []);

  const loadFfmpeg = async () => {
    try {
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
      const ffmpeg = ffmpegRef.current;
      
      ffmpeg.on("log", ({ message }: { message: string }) => {
        console.log("[FFmpeg]", message);
        if (message.includes("time=")) {
           // Basic progress indication from logs
           setProgressText(`Processando vídeo... (${message.split("time=")[1].split(" ")[0]})`);
        }
      });

      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      setIsFfmpegLoaded(true);
    } catch (e) {
      console.error("Erro ao carregar FFmpeg", e);
    }
  };

  const handleExtract = async () => {
    if (!url) return;
    setAppState("extracting");
    setErrorMsg("");
    setProgressText("Analisando página e extraindo links ocultos...");
    
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || "Falha na extração");
      }

      setMediaType(data.type);
      if (data.title) setMediaTitle(data.title);
      
      if (data.type === "music") {
        setQualities([
          { name: "MP3 (320kbps Alta Qualidade)", url: data.url, format: "mp3" },
          { name: "WAV (Sem Compressão / Lossless)", url: data.url, format: "wav" },
          { name: "Áudio Original (AAC/Nativo)", url: data.url, format: "original" }
        ]);
        setAppState("selecting_quality");
      } else {
        // Fetch M3U8 and parse qualities
        setProgressText("Lendo qualidades disponíveis...");
        const m3u8Res = await fetch(`/api/proxy?url=${encodeURIComponent(data.url)}`);
        if (!m3u8Res.ok) throw new Error("Não foi possível ler o arquivo de vídeo.");
        
        const m3u8Text = await m3u8Res.text();
        const baseDir = data.url.replace(/[^/]+\.m3u8.*$/, "");
        
        const parsedQualities: Quality[] = [];
        const lines = m3u8Text.split("\n");
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
            const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
            let nextLine = lines[i+1]?.trim();
            if (nextLine && !nextLine.startsWith("#")) {
              const streamUrl = nextLine.startsWith("http") ? nextLine : baseDir + nextLine;
              let name = resMatch ? resMatch[1] : "Vídeo";
              
              if (nextLine.includes("_1080p")) name = "1080p";
              else if (nextLine.includes("_720p")) name = "720p";
              else if (nextLine.includes("_2160p")) name = "4K";
              else if (nextLine.includes("_480p")) name = "480p";

              parsedQualities.push({ name, url: streamUrl, resolution: resMatch?.[1] });
            }
          }
        }
        
        if (parsedQualities.length === 0) {
           // Talvez já seja o link da qualidade direta
           parsedQualities.push({ name: "Qualidade Única", url: data.url });
        }
        
        setQualities(parsedQualities.reverse()); // Mais alta primeiro
        setAppState("selecting_quality");
      }
      
    } catch (error: any) {
      setAppState("error");
      setErrorMsg(error.message);
    }
  };

  const startDownloadAndProcess = async (quality: Quality) => {
    setSelectedQuality(quality);
    setAppState("downloading");
    setErrorMsg("");
    setProgressPercent(0);
    
    try {
      const ffmpeg = ffmpegRef.current;
      if (!isFfmpegLoaded) {
         setProgressText("Aguardando carregamento do motor de processamento...");
         await loadFfmpeg();
      }

      if (mediaType === "music") {
        setProgressText("Baixando áudio original...");
        const res = await fetch(`/api/proxy?url=${encodeURIComponent(quality.url)}`);
        const buffer = await res.arrayBuffer();
        
        setProgressText("Processando áudio...");
        setAppState("processing");
        
        const extMatch = quality.url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
        const originalExt = extMatch ? extMatch[1] : "aac";

        await ffmpeg.writeFile(`input.${originalExt}`, new Uint8Array(buffer));
        
        const targetFormat = quality.format || "original";
        
        if (targetFormat === "mp3") {
          setProgressText("Convertendo para MP3 (320kbps)...");
          await ffmpeg.exec(["-i", `input.${originalExt}`, "-b:a", "320k", "output.mp3"]);
          const output = await ffmpeg.readFile("output.mp3");
          triggerDownload(output as Uint8Array, "mp3", "audio/mpeg");
        } else if (targetFormat === "wav") {
          setProgressText("Convertendo para WAV (Sem Compressão)...");
          await ffmpeg.exec(["-i", `input.${originalExt}`, "output.wav"]);
          const output = await ffmpeg.readFile("output.wav");
          triggerDownload(output as Uint8Array, "wav", "audio/wav");
        } else {
          setProgressText("Copiando áudio original...");
          await ffmpeg.exec(["-i", `input.${originalExt}`, "-c", "copy", `output.${originalExt}`]);
          const output = await ffmpeg.readFile(`output.${originalExt}`);
          const mimeType = originalExt === "mp3" ? "audio/mpeg" : "audio/aac";
          triggerDownload(output as Uint8Array, originalExt, mimeType);
        }
        
      } else {
        // Video HLS Process
        setProgressText("Buscando playlist do vídeo...");
        const res = await fetch(`/api/proxy?url=${encodeURIComponent(quality.url)}`);
        const m3u8Text = await res.text();
        const baseDir = quality.url.replace(/[^/]+\.m3u8.*$/, "");
        
        const lines = m3u8Text.split("\n");
        const chunkUrls: string[] = [];
        
        for (let line of lines) {
          line = line.trim();
          if (line && !line.startsWith("#")) {
            chunkUrls.push(line.startsWith("http") ? line : baseDir + line);
          }
        }
        
        if (chunkUrls.length === 0) throw new Error("Nenhum segmento de vídeo encontrado.");
        
        let localPlaylist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n";
        
        for (let i = 0; i < chunkUrls.length; i++) {
          setProgressText(`Baixando pedaço do vídeo ${i + 1} de ${chunkUrls.length}...`);
          setProgressPercent(Math.round(((i) / chunkUrls.length) * 100));
          
          const chunkRes = await fetch(`/api/proxy?url=${encodeURIComponent(chunkUrls[i])}`);
          if (!chunkRes.ok) throw new Error("Falha ao baixar pedaço do vídeo.");
          const chunkBuffer = await chunkRes.arrayBuffer();
          
          const chunkName = `chunk_${i}.ts`;
          await ffmpeg.writeFile(chunkName, new Uint8Array(chunkBuffer));
          
          localPlaylist += `#EXTINF:5.0,\n${chunkName}\n`;
        }
        localPlaylist += "#EXT-X-ENDLIST\n";
        
        setProgressPercent(100);
        setAppState("processing");
        setProgressText("Juntando pedaços (Sem perda de qualidade)... Isso usa seu processador local.");
        
        await ffmpeg.writeFile("playlist.m3u8", localPlaylist);
        
        // Apenas junta os pedaços (muxing) sem recodificar, mantendo a qualidade original 100%.
        // Otimizamos também a indexação (faststart) e o cabeçalho de áudio para Premiere/Resolve.
        const ret = await ffmpeg.exec([
          "-i", "playlist.m3u8", 
          "-c", "copy", 
          "-bsf:a", "aac_adtstoasc",
          "-movflags", "+faststart",
          "output.mp4"
        ]);
        
        if (ret !== 0) throw new Error("Erro interno ao juntar vídeo.");
        
        const output = await ffmpeg.readFile("output.mp4");
        triggerDownload(output as Uint8Array, "mp4", "video/mp4");
      }
      
      setAppState("done");
      setProgressText("Download concluído com sucesso!");
      
    } catch (error: any) {
      setAppState("error");
      setErrorMsg(error.message);
    }
  };

  const triggerDownload = (data: Uint8Array, extension: string, mime: string) => {
    const filename = `${mediaTitle}.${extension}`;
    // Usando application/octet-stream para forçar o Safari a respeitar o nome/extensão do arquivo no download
    const blob = new Blob([data as any], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    setDownloadFilename(filename);
    setDownloadUrl(url);
    // Removemos o a.click() automático, deixaremos o usuário clicar no botão "Baixar Arquivo" no UI.
  };

  return (
    <main className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center p-4 selection:bg-[#dfff00] selection:text-black">
      
      {/* HEADER */}
      <div className="text-center mb-12">
        <h1 className="text-5xl md:text-6xl font-black mb-4 tracking-tight">
          <span className="text-[#dfff00]">ART</span>
          <span className="text-gray-600 mx-1">//</span>
          <span className="text-[#dfff00]">LOADER</span>
        </h1>
        <p className="text-[#555] tracking-[0.25em] text-[10px] md:text-xs font-mono uppercase">
          Artlist Footage & Music Downloader
        </p>
      </div>

      {/* MAIN PANEL */}
      <div className="border border-[#222] bg-[#111] p-6 md:p-10 w-full max-w-3xl shadow-2xl">
        
        {/* INPUT STATE */}
        {(appState === "idle" || appState === "extracting" || appState === "error") && (
          <div>
            <label className="block text-[#555] text-[10px] md:text-xs font-mono uppercase mb-3 tracking-widest">
              URL do Artlist
            </label>
            <div className="flex flex-col md:flex-row border border-[#333] focus-within:border-[#555] transition-colors">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://artlist.io/stock-footage/clip/..."
                className="flex-1 bg-[#0a0a0a] text-gray-300 font-mono text-sm px-5 py-4 outline-none w-full"
                disabled={appState === "extracting"}
              />
              <button
                onClick={handleExtract}
                disabled={!url || appState === "extracting"}
                className={`px-8 py-4 text-sm font-bold tracking-[0.1em] uppercase flex items-center justify-center transition-all ${
                  !url
                    ? "bg-[#222] text-[#555] cursor-not-allowed"
                    : appState === "extracting"
                    ? "bg-[#dfff00]/50 text-black cursor-wait"
                    : "bg-[#dfff00] text-black hover:bg-[#bfff00]"
                }`}
              >
                {appState === "extracting" ? "AGUARDE..." : "ANALISAR"}
              </button>
            </div>
            
            {appState === "error" && (
              <div className="mt-4 p-4 border border-red-500/30 bg-red-500/10 text-red-400 font-mono text-xs flex gap-3">
                <span>[ERRO]</span> {errorMsg}
              </div>
            )}
          </div>
        )}

        {/* QUALITY SELECTION */}
        {appState === "selecting_quality" && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6 flex items-center justify-between border-b border-[#222] pb-4">
              <p className="text-[#555] text-xs font-mono uppercase tracking-widest">
                {mediaType === "music" ? "Áudio Pronto" : "Selecione a Qualidade"}
              </p>
              <button onClick={() => setAppState("idle")} className="text-[#555] hover:text-white font-mono text-xs uppercase tracking-widest">
                [ VOLTAR ]
              </button>
            </div>
            
            <div className="grid gap-2">
              {qualities.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => startDownloadAndProcess(q)}
                  className="flex items-center justify-between p-4 border border-[#333] bg-[#0a0a0a] hover:border-[#dfff00] hover:text-[#dfff00] group transition-all text-left"
                >
                  <span className="font-mono text-sm text-gray-300 group-hover:text-[#dfff00]">
                    &gt; {q.name} {q.resolution && `(${q.resolution})`}
                  </span>
                  <span className="font-mono text-xs text-[#555] group-hover:text-[#dfff00]">
                    [ BAIXAR ]
                  </span>
                </button>
              ))}
              {qualities.length === 0 && mediaType === "music" && selectedQuality && (
                <button
                  onClick={() => startDownloadAndProcess(selectedQuality)}
                  className="flex items-center justify-between p-4 border border-[#333] bg-[#0a0a0a] hover:border-[#dfff00] hover:text-[#dfff00] group transition-all text-left"
                >
                  <span className="font-mono text-sm text-gray-300 group-hover:text-[#dfff00]">
                    &gt; ÁUDIO ORIGINAL
                  </span>
                  <span className="font-mono text-xs text-[#555] group-hover:text-[#dfff00]">
                    [ BAIXAR ]
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* PROCESSING / DONE */}
        {(appState === "downloading" || appState === "processing" || appState === "done") && (
          <div className="py-4 animate-in fade-in duration-300 font-mono">
            <div className="mb-8 border border-[#222] bg-[#0a0a0a] p-4">
              <p className="text-xs text-[#555] mb-2 uppercase tracking-widest">Status da Operação</p>
              <p className={`text-sm ${appState === "done" ? "text-[#dfff00]" : "text-gray-300"}`}>
                &gt; {progressText}
              </p>
              
              {appState === "downloading" && (
                <div className="mt-4 flex items-center gap-4">
                  <div className="flex-1 h-1 bg-[#222]">
                    <div 
                      className="h-full bg-[#dfff00] transition-all duration-100"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <span className="text-[#dfff00] text-xs">[{progressPercent}%]</span>
                </div>
              )}
            </div>

            {appState === "done" && (
              <div className="flex flex-col md:flex-row gap-4 mt-6">
                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    download={downloadFilename}
                    className="flex-1 text-center py-4 bg-[#dfff00] hover:bg-[#bfff00] text-black font-bold uppercase text-sm tracking-widest transition-colors"
                  >
                    SALVAR ({downloadFilename})
                  </a>
                )}
                <button
                  onClick={() => {
                    setUrl("");
                    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
                    setDownloadUrl(null);
                    setAppState("idle");
                  }}
                  className="px-8 py-4 border border-[#333] hover:border-gray-500 text-gray-400 hover:text-white uppercase text-sm tracking-widest transition-colors"
                >
                  NOVO ARQUIVO
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-12 text-center text-[#444] font-mono text-[10px] md:text-xs tracking-[0.2em] uppercase">
        transcodificação no seu navegador · ffmpeg.wasm
      </div>
    </main>
  );
}
