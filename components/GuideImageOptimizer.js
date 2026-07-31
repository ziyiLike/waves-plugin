import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { _path } from '../model/path.js';

const MEBIBYTE = 1024 * 1024;
const MAX_SEND_BYTES = Math.floor(3.5 * MEBIBYTE);
const TARGET_SEND_BYTES = 3 * MEBIBYTE;
const MAX_OUTPUT_WIDTH = 1440;
const MAX_OUTPUT_HEIGHT = 15000;
const MIN_OUTPUT_WIDTH = 720;
const CACHE_VERSION = 'v2';

function cacheName(imagePath, stat) {
    return crypto
        .createHash('sha1')
        .update([
            CACHE_VERSION,
            MAX_SEND_BYTES,
            TARGET_SEND_BYTES,
            MAX_OUTPUT_WIDTH,
            MAX_OUTPUT_HEIGHT,
            path.resolve(imagePath),
            stat.size,
            stat.mtimeMs
        ].join(':'))
        .digest('hex')
        .slice(0, 24);
}

async function encodeJpeg(imagePath, width, quality) {
    return sharp(imagePath, { failOn: 'none', limitInputPixels: false })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({
            width,
            height: MAX_OUTPUT_HEIGHT,
            fit: 'inside',
            withoutEnlargement: true
        })
        .jpeg({
            quality,
            progressive: true,
            mozjpeg: true,
            chromaSubsampling: '4:2:0'
        })
        .toBuffer();
}

/**
 * 将超出 QQBot 稳定发送范围的攻略长图压缩到独立缓存。
 * 原始攻略图不会被覆盖；缓存键包含源文件大小和修改时间，可自动失效。
 */
export async function prepareGuideImage(imagePath) {
    const stat = await fs.promises.stat(imagePath);
    if (!stat.isFile()) throw new Error(`攻略图片不是普通文件: ${imagePath}`);

    const metadata = await sharp(imagePath, {
        failOn: 'none',
        limitInputPixels: false
    }).metadata();
    const exceedsDimensions =
        (metadata.width || 0) > MAX_OUTPUT_WIDTH ||
        (metadata.height || 0) > MAX_OUTPUT_HEIGHT;

    if (stat.size <= MAX_SEND_BYTES && !exceedsDimensions) {
        return {
            path: imagePath,
            optimized: false,
            originalBytes: stat.size,
            bytes: stat.size
        };
    }

    const cacheDir = path.join(_path, 'data', 'wavesStrategy', 'optimized');
    await fs.promises.mkdir(cacheDir, { recursive: true });

    const cacheFile = path.join(cacheDir, `${cacheName(imagePath, stat)}.jpg`);
    try {
        const cacheStat = await fs.promises.stat(cacheFile);
        if (cacheStat.isFile() && cacheStat.size <= MAX_SEND_BYTES) {
            return {
                path: cacheFile,
                optimized: true,
                originalBytes: stat.size,
                bytes: cacheStat.size
            };
        }
    } catch {}

    let width = Math.min(metadata.width || MAX_OUTPUT_WIDTH, MAX_OUTPUT_WIDTH);
    let quality = 82;
    let output = null;

    // 先保留尽可能多的文字清晰度，再依据实际编码体积逐级降宽和质量。
    for (let attempt = 0; attempt < 8; attempt += 1) {
        output = await encodeJpeg(imagePath, width, quality);
        if (output.length <= TARGET_SEND_BYTES) break;

        const sizeRatio = Math.sqrt(TARGET_SEND_BYTES / output.length);
        const nextWidth = Math.floor(width * Math.min(0.9, Math.max(0.72, sizeRatio * 0.96)));
        width = Math.max(MIN_OUTPUT_WIDTH, nextWidth);
        quality = Math.max(44, quality - 6);
    }

    if (!output || output.length > MAX_SEND_BYTES) {
        output = await encodeJpeg(imagePath, 640, 40);
    }

    if (output.length > MAX_SEND_BYTES) {
        throw new Error(`攻略图片压缩后仍超过限制: ${output.length} bytes`);
    }

    await fs.promises.writeFile(cacheFile, output);
    return {
        path: cacheFile,
        optimized: true,
        originalBytes: stat.size,
        bytes: output.length
    };
}

export { MAX_SEND_BYTES, TARGET_SEND_BYTES };
