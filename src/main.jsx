import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import {
  Archive,
  Check,
  ChevronRight,
  Download,
  FileImage,
  FolderOpen,
  Images,
  Loader2,
  Play,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import "./styles.css";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff"];

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatFilesCount(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} файл`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} файли`;
  return `${count} файлів`;
}

function cleanName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/g, "");
}

function extensionFromType(type, fallback = "png") {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  return fallback;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Не вдалося прочитати ${file.name}`));
    };
    img.src = url;
  });
}

function findComponents(mask, width, height, minPixels) {
  const seen = new Uint8Array(width * height);
  const components = [];
  const stack = [];

  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || seen[i]) continue;

    stack.length = 0;
    stack.push(i);
    seen[i] = 1;

    let pixels = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (stack.length) {
      const current = stack.pop();
      const x = current % width;
      const y = Math.floor(current / width);
      pixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [current + 1, current - 1, current + width, current - width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || seen[next] || !mask[next]) continue;
        const nextX = next % width;
        if (Math.abs(nextX - x) > 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }

    if (pixels >= minPixels) {
      components.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }

  return components;
}

function mergeSlots(slots) {
  const minX = Math.min(...slots.map((slot) => slot.x));
  const minY = Math.min(...slots.map((slot) => slot.y));
  const maxX = Math.max(...slots.map((slot) => slot.x + slot.width));
  const maxY = Math.max(...slots.map((slot) => slot.y + slot.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function overlapRatio(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  return Math.max(0, right - left) / Math.max(1, Math.min(a.width, b.width));
}

function groupVerticalParts(components) {
  const candidates = components
    .filter((item) => item.width >= 70 && item.width <= 260 && item.height >= 35 && item.height <= 700)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const groups = [];

  for (const component of candidates) {
    let placed = false;
    for (const group of groups) {
      const union = mergeSlots(group);
      const gap = Math.max(component.y - (union.y + union.height), union.y - (component.y + component.height), 0);
      if (overlapRatio(component, union) >= 0.65 && gap <= 170) {
        group.push(component);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([component]);
  }

  return groups.map(mergeSlots);
}

function scoreSlot(slot, imageWidth, imageHeight) {
  const aspect = slot.width / Math.max(1, slot.height);
  const targetAspect = 328 / 638;
  const aspectScore = Math.max(0, 1 - Math.abs(aspect - targetAspect) * 2.8);
  const sizeScore = Math.min((slot.width * slot.height) / 45000, 1);
  const centerBias = 1 - Math.min(Math.abs(slot.x + slot.width / 2 - imageWidth / 2) / imageWidth, 0.5);
  const topPenalty = slot.y < imageHeight * 0.12 ? 0.45 : 1;
  return aspectScore * 4 + sizeScore * 2 + centerBias + topPenalty;
}

function detectGreenSlot(imageData, width, height) {
  const data = imageData.data;
  const mask = new Uint8Array(width * height);

  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    mask[pixel] = green > 125 && red < 95 && blue < 95 && green - red > 55 && green - blue > 55 ? 1 : 0;
  }

  const components = findComponents(mask, width, height, 500);
  const plausible = groupVerticalParts(components).filter((slot) => {
    const aspect = slot.width / Math.max(1, slot.height);
    return slot.width >= 90 && slot.width <= 240 && slot.height >= 170 && slot.height <= 430 && aspect >= 0.35 && aspect <= 0.7;
  });

  if (!plausible.length) {
    throw new Error("Не вдалося знайти зелений банерний слот");
  }

  return plausible.sort((a, b) => scoreSlot(b, width, height) - scoreSlot(a, width, height))[0];
}

function drawBanner(ctx, bannerImage, slot, mode) {
  if (mode === "exact") {
    ctx.drawImage(bannerImage, slot.x, slot.y);
    return;
  }

  if (mode === "fit") {
    ctx.drawImage(bannerImage, slot.x, slot.y, slot.width, slot.height);
    return;
  }

  const ratio = Math.min(slot.width / bannerImage.naturalWidth, slot.height / bannerImage.naturalHeight);
  const width = bannerImage.naturalWidth * ratio;
  const height = bannerImage.naturalHeight * ratio;
  const x = slot.x + (slot.width - width) / 2;
  const y = slot.y + (slot.height - height) / 2;
  ctx.drawImage(bannerImage, x, y, width, height);
}

async function renderJob(parentFile, bannerFile, options) {
  const [{ img: parentImage, url: parentUrl }, { img: bannerImage, url: bannerUrl }] = await Promise.all([
    loadImage(parentFile),
    loadImage(bannerFile),
  ]);

  try {
    const canvas = document.createElement("canvas");
    canvas.width = parentImage.naturalWidth;
    canvas.height = parentImage.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(parentImage, 0, 0);

    const slot =
      options.slotMode === "manual"
        ? {
            x: Number(options.manual.x),
            y: Number(options.manual.y),
            width: Number(options.manual.width),
            height: Number(options.manual.height),
          }
        : detectGreenSlot(ctx.getImageData(0, 0, canvas.width, canvas.height), canvas.width, canvas.height);

    drawBanner(ctx, bannerImage, slot, options.pasteMode);

    const type = parentFile.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, type === "image/jpeg" ? 0.95 : undefined));
    const outputUrl = URL.createObjectURL(blob);
    const ext = extensionFromType(type);
    const filename = `${cleanName(parentFile.name)}__${cleanName(bannerFile.name)}.${ext}`;

    return {
      id: `${parentFile.name}-${bannerFile.name}-${crypto.randomUUID()}`,
      filename,
      blob,
      url: outputUrl,
      slot,
      size: blob.size,
      parentName: parentFile.name,
      bannerName: bannerFile.name,
      status: "done",
    };
  } finally {
    URL.revokeObjectURL(parentUrl);
    URL.revokeObjectURL(bannerUrl);
  }
}

function FileDrop({ title, subtitle, files, onFiles, icon: Icon, accent, targetCount }) {
  const inputRef = useRef(null);
  const folderInputRef = useRef(null);

  function acceptFiles(fileList) {
    const accepted = Array.from(fileList).filter((file) => IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(file.name));
    onFiles(accepted);
  }

  return (
    <section
      className="drop-zone"
      style={{ "--accent": accent }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        acceptFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => acceptFiles(event.target.files)}
      />
      <input
        ref={folderInputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        multiple
        webkitdirectory=""
        directory=""
        onChange={(event) => acceptFiles(event.target.files)}
      />
      <div className="drop-top">
        <span className="drop-icon">
          <Icon size={20} />
        </span>
        <div className="drop-actions">
          <button type="button" className="choose-button" onClick={() => inputRef.current?.click()}>
            <FileImage size={17} />
            Файли
          </button>
          <button type="button" className="choose-button" onClick={() => folderInputRef.current?.click()}>
            <FolderOpen size={17} />
            Папка
          </button>
        </div>
      </div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <div className="file-strip">
        {files.length ? (
          files.slice(0, 5).map((file) => (
            <span className="file-pill" key={`${file.name}-${file.size}`}>
              <FileImage size={14} />
              {file.name}
            </span>
          ))
        ) : (
          <span className="empty-pill">Перетягніть PNG або JPG сюди</span>
        )}
      </div>
      <div className="drop-meta">
        <span>
          {formatFilesCount(files.length)}
          {targetCount ? ` із ${targetCount}` : ""}
        </span>
        <span>{formatBytes(files.reduce((sum, file) => sum + file.size, 0))}</span>
      </div>
    </section>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.hint && <small>{option.hint}</small>}
        </button>
      ))}
    </div>
  );
}

function ResultTile({ result }) {
  return (
    <article className="result-tile">
      <a href={result.url} download={result.filename} className="preview-link">
        <img src={result.url} alt={result.filename} />
      </a>
      <div className="result-info">
        <div>
          <strong>{result.filename}</strong>
          <span>
            {result.slot.x},{result.slot.y} · {result.slot.width}×{result.slot.height}
          </span>
        </div>
        <a href={result.url} download={result.filename} className="icon-button" title="Завантажити зображення">
          <Download size={18} />
        </a>
      </div>
    </article>
  );
}

function App() {
  const [parents, setParents] = useState([]);
  const [banners, setBanners] = useState([]);
  const [pairing, setPairing] = useState("zip");
  const [pasteMode, setPasteMode] = useState("fit");
  const [slotMode, setSlotMode] = useState("auto");
  const [manual, setManual] = useState({ x: 638, y: 401, width: 156, height: 304 });
  const [results, setResults] = useState([]);
  const [log, setLog] = useState([]);
  const [isRunning, setIsRunning] = useState(false);

  const jobCount = useMemo(() => {
    if (pairing === "zip") return Math.min(parents.length, banners.length);
    return parents.length * banners.length;
  }, [banners.length, pairing, parents.length]);

  const jobSummary = useMemo(() => {
    if (!parents.length && !banners.length) return "Основний сценарій: 10 скриншотів + 10 маленьких банерів = 10 готових зображень.";
    if (pairing === "zip") {
      if (parents.length !== banners.length) {
        return `Режим по парах: буде створено ${jobCount}. Зайві файли з більшої групи не використовуються.`;
      }
      return `Режим по парах: ${formatFilesCount(parents.length)} + ${formatFilesCount(banners.length)} = ${jobCount} результатів.`;
    }
    return `Усі комбінації: ${parents.length} × ${banners.length} = ${jobCount} результатів.`;
  }, [banners.length, jobCount, pairing, parents.length]);

  const canRun = parents.length > 0 && banners.length > 0 && !isRunning && jobCount > 0;

  function buildJobs() {
    if (pairing === "zip") {
      return parents.slice(0, Math.min(parents.length, banners.length)).map((parent, index) => [parent, banners[index]]);
    }
    return parents.flatMap((parent) => banners.map((banner) => [parent, banner]));
  }

  async function generate() {
    setIsRunning(true);
    setLog([]);
    results.forEach((item) => URL.revokeObjectURL(item.url));
    setResults([]);

    const nextResults = [];
    const jobs = buildJobs();

    for (let index = 0; index < jobs.length; index += 1) {
      const [parent, banner] = jobs[index];
      setLog((items) => [`${index + 1}/${jobs.length}: ${parent.name} + ${banner.name}`, ...items].slice(0, 6));
      try {
        const result = await renderJob(parent, banner, { pairing, pasteMode, slotMode, manual });
        nextResults.push(result);
        setResults([...nextResults]);
      } catch (error) {
        setLog((items) => [`Помилка: ${parent.name} — ${error.message}`, ...items].slice(0, 6));
      }
    }

    setIsRunning(false);
  }

  async function downloadZip() {
    const zip = new JSZip();
    results.forEach((result) => zip.file(result.filename, result.blob));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `banner-helper-results-${new Date().toISOString().slice(0, 10)}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <Sparkles size={21} />
        </div>
        <div>
          <h1>Помічник банерів</h1>
          <p>Пакетна заміна маленьких банерів у скриншотах без Photoshop.</p>
        </div>
        <div className="status-chip">
          <Check size={15} />
          локально
        </div>
      </header>

      <section className="workspace">
        <div className="left-rail">
          <FileDrop
            title="Батьківські зображення"
            subtitle="10 повних скриншотів сторінки, у яких потрібно замінити банер."
            files={parents}
            onFiles={setParents}
            icon={Images}
            accent="#1ca84b"
            targetCount={10}
          />
          <FileDrop
            title="Нові банери"
            subtitle="10 маленьких банерів, які будуть підставлені у тому самому порядку."
            files={banners}
            onFiles={setBanners}
            icon={FileImage}
            accent="#ff6a2a"
            targetCount={10}
          />

          <section className="control-panel">
            <div className="panel-heading">
              <SlidersHorizontal size={18} />
              <h2>Опції</h2>
            </div>
            <p className="workflow-note">{jobSummary}</p>

            <label>
              Як поєднувати файли
              <Segmented
                value={pairing}
                onChange={setPairing}
                options={[
                  { value: "zip", label: "По парах", hint: "1-й скрин + 1-й банер" },
                  { value: "all", label: "Усі комбінації", hint: "10 × 10 = 100" },
                ]}
              />
            </label>

            <label>
              Де вставляти банер
              <Segmented
                value={slotMode}
                onChange={setSlotMode}
                options={[
                  { value: "auto", label: "Автопошук", hint: "знаходить зелений слот" },
                  { value: "manual", label: "Вручну", hint: "x, y, ширина, висота" },
                ]}
              />
            </label>

            {slotMode === "manual" && (
              <div className="manual-grid">
                {["x", "y", "width", "height"].map((key) => (
                  <label key={key}>
                    {key}
                    <input
                      type="number"
                      value={manual[key]}
                      onChange={(event) => setManual((value) => ({ ...value, [key]: Number(event.target.value) }))}
                    />
                  </label>
                ))}
              </div>
            )}

            <label>
              Як масштабувати банер
              <Segmented
                value={pasteMode}
                onChange={setPasteMode}
                options={[
                  { value: "fit", label: "У слот", hint: "основний режим" },
                  { value: "contain", label: "З полями", hint: "без обрізання" },
                  { value: "exact", label: "1:1", hint: "без зміни розміру" },
                ]}
              />
            </label>

            <button type="button" className="run-button" disabled={!canRun} onClick={generate}>
              {isRunning ? <Loader2 className="spin" size={20} /> : <Play size={20} />}
              {jobCount ? `Згенерувати ${jobCount}` : "Згенерувати"}
              <ChevronRight size={18} />
            </button>
          </section>
        </div>

        <section className="output-panel">
          <div className="output-header">
            <div>
              <h2>Результати</h2>
              <p>{results.length ? `${formatFilesCount(results.length)} готово` : "Готові зображення з'являться тут."}</p>
            </div>
            <button type="button" className="zip-button" disabled={!results.length} onClick={downloadZip}>
              <Archive size={18} />
              Завантажити ZIP
            </button>
          </div>

          {isRunning || log.length ? (
            <div className="process-log">
              {isRunning && <Loader2 className="spin" size={18} />}
              <div>
                {log.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
              {!isRunning && log.length > 0 && (
                <button type="button" className="clear-log" onClick={() => setLog([])} title="Очистити журнал">
                  <X size={16} />
                </button>
              )}
            </div>
          ) : null}

          {results.length ? (
            <div className="result-grid">
              {results.map((result) => (
                <ResultTile key={result.id} result={result} />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-frame">
                <Images size={48} />
              </div>
              <h2>Готово до пакетної заміни</h2>
              <p>Додайте 10 скриншотів і 10 банерів, потім натисніть “Згенерувати”.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
