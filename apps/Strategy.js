import plugin from '../../../lib/plugins/plugin.js';
import { pluginResources } from '../model/path.js';
import Config from "../components/Config.js";
import Wiki from '../components/Wiki.js';
import CommunityGuide from '../components/CommunityGuide.js';
import { prepareGuideImage } from '../components/GuideImageOptimizer.js';
import fs from 'fs';
import path from 'path';

const AUTHORS = [
    'XMu',
    'moealkyne',
    'ruozi',
    'jiexing',
    'Linn'
];

const GUIDE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const BUTTONS_PER_ROW = 7;

function findLocalGuide(directory, roleName) {
    for (const extension of GUIDE_EXTENSIONS) {
        const imagePath = path.join(directory, `${roleName}${extension}`);
        if (fs.existsSync(imagePath)) return imagePath;
    }
    return null;
}

function buildGuideButtons(roleName, guideCount) {
    if (guideCount < 2 || typeof globalThis.segment?.button !== 'function') return null;

    const buttons = Array.from({ length: guideCount }, (_, index) => ({
        text: String(index + 1),
        callback: `~${roleName}攻略${index + 1}`
    }));
    const rows = [];
    for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
        rows.push(buttons.slice(index, index + BUTTONS_PER_ROW));
    }

    try {
        return globalThis.segment.button(...rows);
    } catch {
        return null;
    }
}

function formatMebibytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export class Strategy extends plugin {
    constructor() {
        super({
            name: "鸣潮-攻略",
            event: "message",
            priority: 1009,
            rule: [
                {
                    reg: "^(?:～|~|鸣潮)(.*?)攻略(\\d+)?$",
                    fnc: "strategy"
                }
            ]
        });
    }

    async strategy(e) {
        const [, message, requestedGuide] = e.msg.match(this.rule[0].reg);
        const query = message.trim();
        if (!query) return e.reply("请输入正确的命令格式，如：[～今汐攻略]")
        const wiki = new Wiki();
        const name = await wiki.getAlias(query);
        const provide = Config.getConfig()?.strategy_provide || 'all';
        const guides = [];
        const guidePaths = new Set();
        const addGuide = (imagePath) => {
            if (!imagePath) return;
            const resolvedPath = path.resolve(imagePath);
            if (guidePaths.has(resolvedPath)) return;
            guidePaths.add(resolvedPath);
            guides.push(resolvedPath);
        };

        if (provide === "all") {
            for (const provider of AUTHORS) {
                addGuide(findLocalGuide(path.join(pluginResources, 'Strategy', provider), name));
            }
        } else {
            addGuide(findLocalGuide(path.join(pluginResources, 'Strategy', provide), name));
        }

        try {
            const { guides: communityGuides } = await CommunityGuide.getCommunityGuides(name);
            if (communityGuides.length > 0) {
                const roleInfo = await CommunityGuide.getRoleGbId(name);
                if (roleInfo) {
                    const screenshotMap = await CommunityGuide.captureGuideScreenshots(
                        roleInfo.roleGbId,
                        communityGuides
                    );
                    for (const guide of communityGuides) {
                        const screenshotPath = screenshotMap.get(guide.guideId);
                        addGuide(screenshotPath);
                    }
                }
            }
        } catch (err) {
            logger.mark(logger.blue('[WAVES PLUGIN]'), logger.cyan('获取《鸣潮》|攻略站 攻略失败'), logger.red(err));
        }

        if (guides.length === 0) {
            if (/^(～|~|鸣潮)/.test(e.msg)) {
                await e.reply(`暂时还没有${query}的攻略`);
                return true;
            }
            return false;
        }

        const requestedIndex = Number.parseInt(requestedGuide || '1', 10);
        if (!Number.isInteger(requestedIndex) || requestedIndex < 1 || requestedIndex > guides.length) {
            await e.reply(`第 ${requestedGuide} 份攻略暂时不可用，请重新发送“~${name}攻略”刷新列表`);
            return true;
        }

        const selectedIndex = requestedIndex - 1;
        let imagePath = guides[selectedIndex];

        logger.debug(
            logger.blue('[WAVES PLUGIN]'),
            `发送第 ${requestedIndex}/${guides.length} 份攻略: ${path.basename(imagePath)}`
        );

        try {
            const prepared = await prepareGuideImage(imagePath);
            imagePath = prepared.path;
            if (prepared.optimized) {
                logger.mark(
                    logger.blue('[WAVES PLUGIN]'),
                    logger.green(
                        `攻略图已压缩: ${formatMebibytes(prepared.originalBytes)} -> ${formatMebibytes(prepared.bytes)}`
                    )
                );
            }
        } catch (err) {
            logger.mark(
                logger.blue('[WAVES PLUGIN]'),
                logger.cyan('攻略图片压缩失败，尝试发送原图'),
                logger.red(err)
            );
        }

        const reply = [segment.image(imagePath)];
        const buttons = buildGuideButtons(name, guides.length);
        if (buttons) reply.push(buttons);

        await e.reply(reply.length === 1 ? reply[0] : reply);
        return true;
    }
}
