"use client";

import { useState, useRef, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { Plus, Trash2, Download, Loader2, CheckCircle, AlertCircle, Play, Sparkles, RefreshCw } from "lucide-react";

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
  const [uiStep, setUiStep] = useState<"links" | "format" | "processing" | "done">("links");

  const ffmpegRef = useRef<any>(null);
  const [isFfmpegLoaded, setIsFfmpegLoaded] = useState(false);

  useEffect(() => {
    if (!ffmpegRef.current) {
      ffmpegRef.current = new FFmpeg();
    }
    loadFfmpeg();

    // Captura link injetado pela extensão caso disponível
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const injected = params.get("url");
      if (injected) {
        setItems([{ id: "injected_1", url: injected, status: "idle" }]);
      }
    }
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
      const item = items.find(it => it.id === id);
      if (item?.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
      setItems(prev => prev.filter(it => it.id !== id));
    }
  };

  const updateUrl = (id: string, newUrl: string) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, url: newUrl } : item));
  };

  const resetAll = () => {
    items.forEach(it => {
      if (it.downloadUrl) URL.revokeObjectURL(it.downloadUrl);
    });
    setItems([{ id: "1", url: "", status: "idle" }]);
    setUiStep("links");
  };

  const handleTriggerFormatSelection = () => {
    const validItems = items.filter(item => item.url.trim() !== "");
    if (validItems.length === 0) return;

    // Inspeciona de forma inteligente se há algum link que possa ser de música/sfx
    const hasAudioLink = validItems.some(it => {
      const u = it.url.toLowerCase();
      // Consideramos áudio se a URL tiver /song/, /sfx/, /royalty-free-music/, /sound-effects/ ou se NÃO tiver indícios claros de vídeo
      const isClearlyVideo = u.includes("/stock-footage/") || u.includes("/video/") || u.includes("/clip/");
      return !isClearlyVideo;
    });

    if (hasAudioLink) {
      setUiStep("format");
    } else {
      // Se a lista só tem vídeos, pula a pergunta de formato de áudio e vai direto para a transcodificação!
      setUiStep("processing");
      setTimeout(() => {
        startBatchProcess("mp3"); // formato default inofensivo para vídeos
      }, 50);
    }
  };

  const handleSelectFormatAndStart = (fmt: "mp3" | "wav" | "original") => {
    setGlobalMusicFormat(fmt);
    setUiStep("processing");
    // Pequeno delay para o React atualizar a interface visualmente antes do loop de processamento intenso
    setTimeout(() => {
      startBatchProcess(fmt);
    }, 50);
  };

  const startBatchProcess = async (fmt: "mp3" | "wav" | "original") => {
    const validItems = items.filter(item => item.url.trim() !== "");
    if (validItems.length === 0) {
      setUiStep("links");
      return;
    }

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

          if (fmt === "mp3") {
            outputFilename = `output_${i}.mp3`;
            finalExt = "mp3";
            await ffmpeg.exec(["-i", inputName, "-b:a", "320k", outputFilename]);
          } else if (fmt === "wav") {
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
          progressText: undefined,
          error: err.message || "Erro de processamento" 
        } : it));
      }
    }

    setUiStep("done");
  };

  const downloadAllFinished = () => {
    const doneItems = items.filter(it => it.status === "done" && it.downloadUrl);
    doneItems.forEach((item, index) => {
      // Pequeno intervalo entre downloads para não disparar bloqueador de pop-up do Chrome/Safari
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = item.downloadUrl!;
        a.download = item.filename || "download";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, index * 400);
    });
  };

  const hasLinks = items.some(it => it.url.trim() !== "");
  const hasAudioLink = items.some(it => {
    if (it.type === "music") return true;
    const u = it.url.toLowerCase();
    const isClearlyVideo = u.includes("/stock-footage/") || u.includes("/video/") || u.includes("/clip/");
    return !isClearlyVideo && it.url.trim() !== "";
  });

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

      {/* BATCH PANEL */}
      <div className="border border-[#222] bg-[#111] p-5 md:p-8 w-full max-w-4xl shadow-2xl rounded-sm">
        
        {/* LINKS LIST */}
        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between border-b border-[#222] pb-3 px-1">
            <span className="text-[#555] font-mono text-xs uppercase tracking-widest">
              Lista de Mídias ({items.length}) {hasAudioLink && globalMusicFormat && uiStep !== "links" && `· Áudio: ${globalMusicFormat.toUpperCase()}`}
            </span>
            <button 
              onClick={resetAll}
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
                  disabled={uiStep === "processing" && item.status !== "idle" && item.status !== "error"}
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
                    disabled={uiStep === "processing" && item.status !== "idle" && item.status !== "error"}
                    title="Deletar Link"
                    className="p-3 bg-[#161616] border border-[#222] hover:border-red-500 hover:text-red-400 text-[#555] transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {/* IFRAME INVISÍVEL LOCAL (PRE-WARMER EXPERIMENTAL) */}
              {item.status === "analyzing" && item.url && (
                <iframe 
                  src={item.url} 
                  title="injector" 
                  style={{ width: 1, height: 1, opacity: 0, position: "absolute", pointerEvents: "none" }} 
                />
              )}

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
                      {item.title && item.status !== "error" ? `[${item.title}] ` : ""}{item.status === "error" ? item.error : item.progressText}
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

        {/* BOTTOM DYNAMIC ACTION CONTROLS */}
        <div className="pt-4 border-t border-[#222]">
          {uiStep === "links" && (
            <div className="flex flex-col md:flex-row gap-4 animate-in fade-in duration-200">
              <button
                onClick={addLinkBox}
                className="flex-1 py-4 border border-[#333] hover:border-[#dfff00] bg-[#0a0a0a] text-gray-400 hover:text-[#dfff00] font-mono text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all"
              >
                <Plus size={16} /> Adicionar Mais Link
              </button>

              <button
                onClick={handleTriggerFormatSelection}
                disabled={!hasLinks}
                className={`flex-1 py-4 font-bold font-mono text-xs uppercase tracking-widest flex items-center justify-center gap-3 transition-all shadow-xl ${
                  !hasLinks
                    ? "bg-[#1a1a1a] text-[#444] border border-[#222] cursor-not-allowed"
                    : "bg-[#dfff00] text-black hover:bg-[#bfff00]"
                }`}
              >
                <Sparkles size={16} fill="currentColor" /> Processar Mídias
              </button>
            </div>
          )}

          {uiStep === "format" && (
            <div className="p-5 border border-[#dfff00]/30 bg-[#dfff00]/5 rounded-sm text-center animate-in fade-in zoom-in-95 duration-200">
              <p className="text-[#dfff00] font-mono text-xs uppercase tracking-wider mb-4">
                ⚡ Selecione o formato de conversão para as Músicas da lista:
              </p>
              
              <div className="flex flex-wrap justify-center gap-3">
                {(["mp3", "wav", "original"] as const).map(fmt => (
                  <button
                    key={fmt}
                    onClick={() => handleSelectFormatAndStart(fmt)}
                    className="px-6 py-3 bg-[#0a0a0a] border border-[#333] hover:border-[#dfff00] hover:text-[#dfff00] font-mono text-xs uppercase tracking-widest text-gray-300 transition-all flex items-center gap-2"
                  >
                    {fmt === "original" ? "AAC Original" : fmt}
                  </button>
                ))}
              </div>

              <p className="text-[#666] font-mono text-[10px] mt-4">
                Vídeos da lista serão extraídos na Qualidade Máxima Original automaticamente
              </p>
            </div>
          )}

          {uiStep === "processing" && (
            <div className="py-4 bg-[#111] border border-[#222] text-center">
              <button disabled className="w-full py-2 text-[#dfff00] font-mono text-xs uppercase tracking-widest inline-flex items-center justify-center gap-3 cursor-wait">
                <Loader2 size={16} className="animate-spin" /> Transcodificando Lote em Andamento...
              </button>
            </div>
          )}

          {uiStep === "done" && (
            <div className="flex flex-col md:flex-row gap-4 animate-in fade-in duration-300">
              <button
                onClick={downloadAllFinished}
                className="flex-1 py-4 bg-[#dfff00] hover:bg-[#bfff00] text-black font-bold font-mono text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-2xl"
              >
                <Download size={16} /> Baixar Todos os Arquivos
              </button>

              <button
                onClick={resetAll}
                className="px-8 py-4 border border-[#333] hover:border-[#555] bg-[#0a0a0a] text-gray-400 hover:text-white font-mono text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all"
              >
                <RefreshCw size={14} /> Novo Lote
              </button>
            </div>
          )}
        </div>

      </div>

      {/* FOOTER */}
      <div className="mt-8 text-center text-[#444] font-mono text-[10px] md:text-xs tracking-[0.2em] uppercase">
        Processamento Sequencial Seguro em Nuvem · FFmpeg.wasm
      </div>
    </main>
  );
}
