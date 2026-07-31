import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { _path } from '../model/path.js';

const MEBIBYTE = 1024 * 1024;
const MAX_SEND_BYTES = MEBIBYTE;
const TARGET_SEND_BYTES = 900 * 1024;
const MAX_OUTPUT_WIDTH = 1440;
// 腾讯图片处理链路要求输出宽高小于 10000px。
const MAX_OUTPUT_HEIGHT = 9999;
const MIN_OUTPUT_WIDTH = 720;
const JPEG_QUALITIES = [82, 76, 70, 64, 58];
const MAX_RESIZE_ATTEMPTS = 4;
const CACHE_VERSION = 'v6';

function imageMetadata(metadata) {
    return {
        width: metadata.width || 0,
        height: metadata.height || 0,
        format: metadata.format || 'unknown',
        progressive: Boolean(metadata.isProgressive)
    };
}

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
            // QQ Markdown 的图片代理对超长渐进式 JPEG 兼容性不稳定，统一输出基线 JPEG。
            progressive: false,
            mozjpeg: false,
            optimiseCoding: true,
            chromaSubsampling: '4:2:0'
        })
        .toBuffer();
}

/**
 * 将攻略图转换为 QQ 图片代理兼容性更好的基线 JPEG，并在必要时压缩。
 * 原始攻略图不会被覆盖；缓存键包含源文件大小和修改时间，可自动失效。
 */
export async function prepareGuideImage(imagePath) {
    const stat = await fs.promises.stat(imagePath);
    if (!stat.isFile()) throw new Error(`攻略图片不是普通文件: ${imagePath}`);

    const metadata = await sharp(imagePath, {
        failOn: 'none',
        limitInputPixels: false
    }).metadata();
    const exceedsWidth = (metadata.width || 0) > MAX_OUTPUT_WIDTH;
    const exceedsHeight = (metadata.height || 0) > MAX_OUTPUT_HEIGHT;
    const needsBaselineJpeg = metadata.format !== 'jpeg' || Boolean(metadata.isProgressive);

    if (
        stat.size <= MAX_SEND_BYTES &&
        !exceedsWidth &&
        !exceedsHeight &&
        !needsBaselineJpeg
    ) {
        return {
            path: imagePath,
            optimized: false,
            originalBytes: stat.size,
            bytes: stat.size,
            ...imageMetadata(metadata)
        };
    }

    const cacheDir = path.join(_path, 'data', 'wavesStrategy', 'optimized');
    await fs.promises.mkdir(cacheDir, { recursive: true });

    const cacheFile = path.join(cacheDir, `${cacheName(imagePath, stat)}.jpg`);
    try {
        const cacheStat = await fs.promises.stat(cacheFile);
        if (cacheStat.isFile() && cacheStat.size <= MAX_SEND_BYTES) {
            const cacheMetadata = await sharp(cacheFile, {
                failOn: 'none',
                limitInputPixels: false
            }).metadata();
            return {
                path: cacheFile,
                optimized: true,
                originalBytes: stat.size,
                bytes: cacheStat.size,
                ...imageMetadata(cacheMetadata)
            };
        }
    } catch {}

    let width = Math.min(metadata.width || MAX_OUTPUT_WIDTH, MAX_OUTPUT_WIDTH);
    let output = null;

    // 攻略图包含大量小字：先降低 JPEG 质量，仍超限时才缩小尺寸。
    compression:
    for (let resizeAttempt = 0; resizeAttempt < MAX_RESIZE_ATTEMPTS; resizeAttempt += 1) {
        for (const quality of JPEG_QUALITIES) {
            output = await encodeJpeg(imagePath, width, quality);
            if (output.length <= TARGET_SEND_BYTES) break compression;
        }

        if (width <= MIN_OUTPUT_WIDTH) break;
        const sizeRatio = Math.sqrt(TARGET_SEND_BYTES / output.length);
        const nextWidth = Math.floor(width * Math.min(0.95, Math.max(0.78, sizeRatio * 0.98)));
        if (nextWidth >= width) break;
        width = Math.max(MIN_OUTPUT_WIDTH, nextWidth);
    }

    if (!output || output.length > MAX_SEND_BYTES) {
        output = await encodeJpeg(imagePath, 640, 40);
    }

    if (output.length > MAX_SEND_BYTES) {
        throw new Error(`攻略图片压缩后仍超过限制: ${output.length} bytes`);
    }

    await fs.promises.writeFile(cacheFile, output);
    const outputMetadata = await sharp(output, {
        failOn: 'none',
        limitInputPixels: false
    }).metadata();
    return {
        path: cacheFile,
        optimized: true,
        originalBytes: stat.size,
        bytes: output.length,
        ...imageMetadata(outputMetadata)
    };
}

export { MAX_SEND_BYTES, TARGET_SEND_BYTES };
