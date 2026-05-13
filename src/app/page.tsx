"use client";

import { useState, useRef, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { Plus, Trash2, Download, Loader2, CheckCircle, AlertCircle, Play } from "lucide-react";

interface BatchItem {
  id: string;
  url: string;
  status: "idle" | "analyzing" | "downloading" | "processing" | "done" | "error";
  title?: string;
  type?: "music" | "footage";
  downloadUrl?: string;
  filename?: string;
  error?: string;
  progressText?: string;
  progressPercent?: number;
}

export default function Home() {
  const [items, setItems] = useState<BatchItem[]>([
    { id: "1", url: "", status: "idle" }
  ]);
  const [globalMusicFormat, setGlobalMusicFormat] = useState<"mp3" | "wav" | "original">("mp3");
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);

  const ffmpegRef = useRef<any>(null);
  const [isFfmpegLoaded, setIsFfmpegLoaded] = useState(false);

  useEffect(() => {
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

  const addLinkBox = () => {
    setItems(prev => [...prev, { id: Date.now().toString(), url: "", status: "idle" }]);
  };

  const removeLinkBox = (id: string) => {
    if (items.length === 1) {
      setItems([{ id: "1", url: "", status: "idle" }]);
    } else {
      // Revoga URL de download se existir para liberar memória
      const item = items.find(it => it.id === id);
      if (item?.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
      setItems(prev => prev.filter(it => it.id !== id));
    }
  };

  const updateUrl = (id: string, newUrl: string) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, url: newUrl } : item));
  };

  const startBatchProcess = async () => {
    const validItems = items.filter(item => item.url.trim() !== "");
    if (validItems.length === 0) return;

    setIsBatchProcessing(true);
    const ffmpeg = ffmpegRef.current;
    if (!isFfmpegLoaded) {
      await loadFfmpeg();
    }

    // Estratégia de altíssima performance: Tenta baixar direto do CDN do Artlist no cliente para velocidade máxima gigabit
    const fetchFast = async (targetUrl: string) => {
      try {
        const res = await fetch(targetUrl);
        if (res.ok) return res;
      } catch (e) {}
      return await fetch(`/api/proxy?url=${encodeURIComponent(targetUrl)}`);
    };

    // Processa link por link para não derrubar a memória do navegador
    for (let i = 0; i < validItems.length; i++) {
      const currentItem = validItems[i];
      
      // Se já foi concluído com sucesso antes, pula
      if (currentItem.status === "done") continue;

      setItems(prev => prev.map(it => it.id === currentItem.id ? { 
        ...it, 
        status: "analyzing", 
        progressText: "Analisando link via API...",
        error: undefined 
      } : it));

      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: currentItem.url.trim() }),
        });
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Mídia protegida ou não encontrada");
        
        const mediaTitle = data.title || `media_${i+1}`;
        const mediaType = data.type;
        
        setItems(prev => prev.map(it => it.id === currentItem.id ? { 
          ...it, 
          title: mediaTitle, 
          type: mediaType, 
          status: "downloading", 
          progressText: "Baixando mídia original em alta velocidade...", 
          progressPercent: 0 
        } : it));

        if (mediaType === "music") {
          // Processamento de Música com download otimizado
          const proxyRes = await fetchFast(data.url);
          if (!proxyRes.ok) throw new Error("Falha ao puxar arquivo de áudio");
          const buffer = await proxyRes.arrayBuffer();
          
          setItems(prev => prev.map(it => it.id === currentItem.id ? { 
            ...it, 
            status: "processing", 
            progressText: "Transcodificando áudio localmente..." 
          } : it));

          const extMatch = data.url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
          const originalExt = extMatch ? extMatch[1] : "aac";
          const inputName = `input_${i}.${originalExt}`;
          await ffmpeg.writeFile(inputName, new Uint8Array(buffer));
          
          let outputFilename = "";
          let finalExt = "";

          if (globalMusicFormat === "mp3") {
            outputFilename = `output_${i}.mp3`;
            finalExt = "mp3";
            await ffmpeg.exec(["-i", inputName, "-b:a", "320k", outputFilename]);
          } else if (globalMusicFormat === "wav") {
            outputFilename = `output_${i}.wav`;
            finalExt = "wav";
            await ffmpeg.exec(["-i", inputName, outputFilename]);
          } else {
            outputFilename = `output_${i}.${originalExt}`;
            finalExt = originalExt;
            await ffmpeg.exec(["-i", inputName, "-c", "copy", outputFilename]);
          }

          const outputData = await ffmpeg.readFile(outputFilename);
          const blob = new Blob([outputData as any], { type: "application/octet-stream" });
          const dUrl = URL.createObjectURL(blob);
          const fName = `${mediaTitle}.${finalExt}`;

          setItems(prev => prev.map(it => it.id === currentItem.id ? { 
            ...it, 
            status: "done", 
            downloadUrl: dUrl, 
            filename: fName, 
            progressText: "Pronto para salvar!" 
          } : it));

        } else {
          // Processamento de Vídeo
          setItems(prev => prev.map(it => it.id === currentItem.id ? { 
            ...it, 
            progressText: "Mapeando qualidades disponíveis do vídeo..." 
          } : it));

          const m3u8Res = await fetchFast(data.url);
          if (!m3u8Res.ok) throw new Error("Falha ao ler o manifesto do vídeo");
          const m3u8Text = await m3u8Res.text();
          const baseDir = data.url.replace(/[^/]+\.m3u8.*$/, "");
          
          let highestQualityUrl = data.url;
          const lines = m3u8Text.split("\n");
          const streamUrls: string[] = [];
          
          for (let j = 0; j < lines.length; j++) {
            if (lines[j].startsWith("#EXT-X-STREAM-INF")) {
              const nextLine = lines[j+1]?.trim();
              if (nextLine && !nextLine.startsWith("#")) {
                streamUrls.push(nextLine.startsWith("http") ? nextLine : baseDir + nextLine);
              }
            }
          }
          
          if (streamUrls.length > 0) {
            highestQualityUrl = streamUrls[streamUrls.length - 1];
          }

          // Busca as partes (chunks) da qualidade final
          setItems(prev => prev.map(it => it.id === currentItem.id ? { 
            ...it, 
            progressText: "Mapeando pedaços do vídeo..." 
          } : it));

          const chunksRes = await fetchFast(highestQualityUrl);
          if (!chunksRes.ok) throw new Error("Falha ao ler playlist de chunks");
          const chunksText = await chunksRes.text();
          const cBaseDir = highestQualityUrl.replace(/[^/]+\.m3u8.*$/, "");
          
          const cLines = chunksText.split("\n");
          const chunkUrls: string[] = [];
          for (let line of cLines) {
            line = line.trim();
            if (line && !line.startsWith("#")) {
              chunkUrls.push(line.startsWith("http") ? line : cBaseDir + line);
            }
          }

          if (chunkUrls.length === 0) throw new Error("Nenhum segmento de vídeo encontrado.");

          let localPlaylist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n";
          let completedChunks = 0;
          const concurrency = 6; // Baixa 6 partes em paralelo

          for (let k = 0; k < chunkUrls.length; k++) {
            localPlaylist += `#EXTINF:5.0,\nchunk_${i}_${k}.ts\n`;
          }
          localPlaylist += "#EXT-X-ENDLIST\n";

          for (let k = 0; k < chunkUrls.length; k += concurrency) {
            const batch = chunkUrls.slice(k, k + concurrency);
            await Promise.all(batch.map(async (cUrl, idx) => {
              const globalIdx = k + idx;
              const chunkRes = await fetchFast(cUrl);
              if (!chunkRes.ok) throw new Error("Falha ao baixar parte do vídeo.");
              const chunkBuffer = await chunkRes.arrayBuffer();
              await ffmpeg.writeFile(`chunk_${i}_${globalIdx}.ts`, new Uint8Array(chunkBuffer));
              
              completedChunks++;
              setItems(prev => prev.map(it => it.id === currentItem.id ? { 
                ...it, 
                progressText: `Baixando pedaços do vídeo (${completedChunks}/${chunkUrls.length})...`,
                progressPercent: Math.round((completedChunks / chunkUrls.length) * 100)
              } : it));
            }));
          }

          setItems(prev => prev.map(it => it.id === currentItem.id ? { 
            ...it, 
            status: "processing", 
            progressText: "Juntando pedaços sem perda de qualidade (Remuxing)..." 
          } : it));

          await ffmpeg.writeFile(`playlist_${i}.m3u8`, localPlaylist);

          const outputName = `output_${i}.mp4`;
          const ret = await ffmpeg.exec([
            "-i", `playlist_${i}.m3u8`, 
            "-c", "copy", 
            "-bsf:a", "aac_adtstoasc",
            "-movflags", "+faststart",
            outputName
          ]);

          if (ret !== 0) throw new Error("Erro interno ao empacotar MP4.");

          const outputData = await ffmpeg.readFile(outputName);
          const blob = new Blob([outputData as any], { type: "application/octet-stream" });
          const dUrl = URL.createObjectURL(blob);
          const fName = `${mediaTitle}.mp4`;

          setItems(prev => prev.map(it => it.id === currentItem.id ? { 
            ...it, 
            status: "done", 
            downloadUrl: dUrl, 
            filename: fName, 
            progressText: "Pronto para salvar!" 
          } : it));
        }

      } catch (err: any) {
        setItems(prev => prev.map(it => it.id === currentItem.id ? { 
          ...it, 
          status: "error", 
          error: err.message || "Erro de processamento" 
        } : it));
      }
    }

    setIsBatchProcessing(false);
  };

  const hasLinks = items.some(it => it.url.trim() !== "");

  return (
    <main className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-start p-4 md:p-8 selection:bg-[#dfff00] selection:text-black">
      
      {/* HEADER */}
      <div className="text-center mt-6 mb-10">
        <h1 className="text-5xl md:text-6xl font-black mb-3 tracking-tight">
          <span className="text-[#dfff00]">ART</span>
          <span className="text-gray-600 mx-1">//</span>
          <span className="text-[#dfff00]">LOADER</span>
        </h1>
        <p className="text-[#555] tracking-[0.25em] text-[10px] md:text-xs font-mono uppercase">
          Downloader Universal · Múltiplos Links Simultâneos
        </p>
      </div>

      {/* CONTROLS & BATCH PANEL */}
      <div className="border border-[#222] bg-[#111] p-5 md:p-8 w-full max-w-4xl shadow-2xl rounded-sm">
        
        {/* GLOBAL OPTIONS BAR */}
        <div className="mb-8 p-4 bg-[#0d0d0d] border border-[#222] flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <span className="block text-gray-400 font-mono text-[11px] uppercase tracking-wider mb-1">
              Formato Global de Saída (Músicas)
            </span>
            <p className="text-[#555] text-[10px] font-mono">Vídeos sempre saem em MP4 com Qualidade Máxima Original</p>
          </div>
          
          <div className="flex gap-2">
            {(["mp3", "wav", "original"] as const).map(fmt => (
              <button
                key={fmt}
                onClick={() => setGlobalMusicFormat(fmt)}
                className={`px-4 py-2 font-mono text-xs uppercase tracking-widest transition-all border ${
                  globalMusicFormat === fmt
                    ? "border-[#dfff00] bg-[#dfff00]/10 text-[#dfff00]"
                    : "border-[#333] text-gray-500 hover:border-[#555] hover:text-gray-300"
                }`}
              >
                {fmt === "original" ? "AAC Original" : fmt}
              </button>
            ))}
          </div>
        </div>

        {/* LINKS LIST */}
        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between border-b border-[#222] pb-3 px-1">
            <span className="text-[#555] font-mono text-xs uppercase tracking-widest">Lista de Mídias ({items.length})</span>
            <button 
              onClick={() => setItems([{ id: "1", url: "", status: "idle" }])}
              className="text-[#555] hover:text-red-400 font-mono text-[10px] uppercase tracking-widest transition-colors"
            >
              [ Limpar Tudo ]
            </button>
          </div>

          {items.map((item, idx) => (
            <div 
              key={item.id} 
              className={`p-4 border transition-all ${
                item.status === "done" 
                  ? "border-green-500/30 bg-green-500/5" 
                  : item.status === "error"
                  ? "border-red-500/30 bg-red-500/5"
                  : item.status !== "idle"
                  ? "border-[#dfff00]/30 bg-[#dfff00]/5"
                  : "border-[#222] bg-[#0a0a0a]"
              }`}
            >
              <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-center">
                <span className="text-[#555] font-mono text-xs px-2 py-1 bg-[#111] border border-[#222] text-center self-start md:self-auto">
                  #{idx + 1}
                </span>

                <input
                  type="url"
                  value={item.url}
                  onChange={(e) => updateUrl(item.id, e.target.value)}
                  placeholder="Cole a URL do Artlist aqui (música, SFX ou vídeo)..."
                  disabled={isBatchProcessing && item.status !== "idle" && item.status !== "error"}
                  className="flex-1 bg-[#050505] border border-[#222] focus:border-[#dfff00] text-gray-300 font-mono text-xs px-4 py-3 outline-none transition-colors disabled:opacity-50"
                />

                <div className="flex gap-2 self-end md:self-auto w-full md:w-auto justify-end">
                  {item.downloadUrl && item.status === "done" && (
                    <a
                      href={item.downloadUrl}
                      download={item.filename || "download"}
                      className="px-4 py-3 bg-[#dfff00] hover:bg-[#bfff00] text-black font-bold font-mono text-xs uppercase tracking-wider flex items-center gap-2 transition-all shadow-lg animate-in fade-in"
                    >
                      <Download size={14} /> Salvar
                    </a>
                  )}

                  <button
                    onClick={() => removeLinkBox(item.id)}
                    disabled={isBatchProcessing && item.status !== "idle" && item.status !== "error"}
                    title="Deletar Link"
                    className="p-3 bg-[#161616] border border-[#222] hover:border-red-500 hover:text-red-400 text-[#555] transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {/* PROGRESS STATUS BAR */}
              {item.status !== "idle" && (
                <div className="mt-3 pt-3 border-t border-[#1a1a1a] flex items-center justify-between gap-4 font-mono text-xs">
                  <div className="flex items-center gap-2 overflow-hidden">
                    {item.status === "analyzing" || item.status === "downloading" || item.status === "processing" ? (
                      <Loader2 size={14} className="text-[#dfff00] animate-spin shrink-0" />
                    ) : item.status === "done" ? (
                      <CheckCircle size={14} className="text-green-400 shrink-0" />
                    ) : (
                      <AlertCircle size={14} className="text-red-400 shrink-0" />
                    )}

                    <span className={`truncate ${
                      item.status === "done" 
                        ? "text-green-400" 
                        : item.status === "error" 
                        ? "text-red-400" 
                        : "text-gray-400"
                    }`}>
                      {item.title ? `[${item.title}] ` : ""}{item.progressText || item.error}
                    </span>
                  </div>

                  {item.status === "downloading" && item.progressPercent !== undefined && (
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="w-20 md:w-32 h-1 bg-[#222] hidden md:block">
                        <div 
                          className="h-full bg-[#dfff00] transition-all duration-100" 
                          style={{ width: `${item.progressPercent}%` }} 
                        />
                      </div>
                      <span className="text-[#dfff00] text-[10px]">[{item.progressPercent}%]</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* BOTTOM GLOBAL BUTTONS */}
        <div className="flex flex-col md:flex-row gap-4 pt-4 border-t border-[#222]">
          <button
            onClick={addLinkBox}
            disabled={isBatchProcessing}
            className="flex-1 py-4 border border-[#333] hover:border-[#dfff00] bg-[#0a0a0a] text-gray-400 hover:text-[#dfff00] font-mono text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all disabled:opacity-50"
          >
            <Plus size={16} /> Adicionar Mais Link
          </button>

          <button
            onClick={startBatchProcess}
            disabled={!hasLinks || isBatchProcessing}
            className={`flex-1 py-4 font-bold font-mono text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all shadow-xl ${
              !hasLinks
                ? "bg-[#1a1a1a] text-[#444] border border-[#222] cursor-not-allowed"
                : isBatchProcessing
                ? "bg-[#dfff00]/30 text-[#dfff00] cursor-wait border border-[#dfff00]"
                : "bg-[#dfff00] text-black hover:bg-[#bfff00]"
            }`}
          >
            {isBatchProcessing ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Processando Fila...
              </>
            ) : (
              <>
                <Play size={16} fill="currentColor" /> Processar e Baixar Todos
              </>
            )}
          </button>
        </div>

      </div>

      {/* FOOTER */}
      <div className="mt-8 text-center text-[#444] font-mono text-[10px] md:text-xs tracking-[0.2em] uppercase">
        Processamento Sequencial Seguro em Nuvem · FFmpeg.wasm
      </div>
    </main>
  );
}
