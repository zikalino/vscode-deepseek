import * as vscode from 'vscode';
import type { VisionProxyStats } from '../../types';
import { Logger } from '../../logger';
import { SETTINGS_NS, IMAGE_DESCRIPTION_PROMPT } from '../../consts';
import { imagePartsKey, isImagePart } from './descriptionKey';

/**
 * Vision Proxy — resolves images by delegating to a vision-capable Copilot model.
 */
export class VisionProxy {
  private log: Logger;
  private cachedModel: vscode.LanguageModelChatInformation | null = null;
  /**
   * Descriptions keyed by image content. A chat message that carries an image
   * stays the "latest" one for every later turn, so without this cache the same
   * image is described again on each request. Model output is not byte-stable,
   * and a changed description rewrites the serialized history — which drops
   * DeepSeek's prompt cache from that message on.
   */
  private descriptions = new Map<string, string>();

  constructor(log: Logger) {
    this.log = log;
  }

  /**
   * Resolve all images in the messages array.
   * Returns the original messages with image parts replaced by text descriptions.
   */
  async resolveImages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): Promise<{
    resolvedMessages: vscode.LanguageModelChatRequestMessage[];
    stats: VisionProxyStats;
  }> {
    const stats: VisionProxyStats = {
      inputImageParts: 0,
      inputImageMessages: 0,
      currentImageMessages: 0,
      replayedImageMessages: 0,
      omittedHistoricalMessages: 0,
      failedMessages: 0,
      unavailableMessages: 0,
      droppedImageParts: 0,
    };

    // Every user message that carries image parts, in conversation order.
    const imageMessageIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if ((msg as any).role !== 'user') continue;
      const imageParts = ((msg as any).content ?? []).filter(isImagePart);
      if (imageParts.length === 0) continue;
      imageMessageIndices.push(i);
      stats.inputImageParts += imageParts.length;
      stats.inputImageMessages++;
    }

    if (imageMessageIndices.length === 0) {
      return { resolvedMessages: [...messages], stats };
    }

    const latestImageUserIdx = imageMessageIndices[imageMessageIndices.length - 1];
    stats.currentImageMessages = 1;
    stats.replayedImageMessages = imageMessageIndices.length - 1;
    stats.omittedHistoricalMessages = stats.replayedImageMessages;

    /**
     * Resolve the description for one image message. The latest message is
     * described when its description is not cached yet; earlier messages only
     * reuse text they resolved to before, so the serialized history stays
     * byte-identical from one request to the next.
     */
    const describe = async (idx: number, generate: boolean): Promise<string | undefined> => {
      const key = imagePartsKey((messages[idx] as any).content ?? []);
      if (key !== undefined) {
        const cached = this.descriptions.get(key);
        if (cached !== undefined) {
          return cached;
        }
      }
      if (!generate) {
        return undefined;
      }

      try {
        const model = await this.getVisionModel();
        if (!model) {
          stats.unavailableMessages++;
          return undefined;
        }
        const description = await this.describeImages(messages[idx], model);
        if (!description) {
          stats.failedMessages++;
          return undefined;
        }
        if (key !== undefined) {
          this.descriptions.set(key, description);
        }
        return description;
      } catch (err) {
        this.log.warn('Vision proxy failed:', err);
        stats.failedMessages++;
        return undefined;
      }
    };

    const descriptions = new Map<number, string>();
    const latestDescription = await describe(latestImageUserIdx, true);
    if (latestDescription !== undefined) {
      descriptions.set(latestImageUserIdx, latestDescription);
    }
    for (const idx of imageMessageIndices) {
      if (idx === latestImageUserIdx) continue;
      const description = await describe(idx, false);
      if (description !== undefined) {
        descriptions.set(idx, description);
      }
    }

    const resolvedMessages = messages.map((msg, idx) => {
      const description = descriptions.get(idx);
      if (description !== undefined) {
        return this.replaceImagesWithText(msg, description);
      }
      if (imageMessageIndices.includes(idx)) {
        // No description was ever produced for this image: dropping it matches
        // what earlier requests carried, instead of sending a fresh image.
        stats.droppedImageParts += ((msg as any).content ?? []).filter(isImagePart).length;
        return this.removeImages(msg);
      }
      return msg;
    });

    return { resolvedMessages, stats };
  }

  private async getVisionModel(): Promise<vscode.LanguageModelChatInformation | null> {
    if (this.cachedModel) return this.cachedModel;

    const configuredModel = vscode.workspace
      .getConfiguration(SETTINGS_NS)
      .get<string>('visionModel', '');

    if (configuredModel) {
      const models = await vscode.lm.selectChatModels({ id: configuredModel });
      if (models && models.length > 0) {
        this.cachedModel = models[0] as any;
        return this.cachedModel;
      }
    }

    // Auto-detect: look for oswe-vscode-prime or any vision-capable model
    const allModels = await vscode.lm.selectChatModels({});
    const visionModel = allModels?.find(
      (m) => m.id === 'oswe-vscode-prime' || m.vendor === 'copilot',
    );
    if (visionModel) {
      this.cachedModel = visionModel as any;
      return this.cachedModel;
    }

    return null;
  }

  private async describeImages(
    message: vscode.LanguageModelChatRequestMessage,
    model: vscode.LanguageModelChatInformation,
  ): Promise<string | null> {
    try {
      const prompt = vscode.workspace
        .getConfiguration(SETTINGS_NS)
        .get<string>('visionPrompt', IMAGE_DESCRIPTION_PROMPT);

      const messages = [
        vscode.LanguageModelChatMessage.User(prompt),
        message,
      ] as vscode.LanguageModelChatMessage[];

      const response = await (model as any).sendRequest(messages, {});
      let description = '';
      for await (const chunk of response.text) {
        description += chunk;
      }
      return description.trim() || null;
    } catch (err) {
      this.log.warn('Vision description failed:', err);
      return null;
    }
  }

  private replaceImagesWithText(
    msg: vscode.LanguageModelChatRequestMessage,
    description: string,
  ): vscode.LanguageModelChatRequestMessage {
    const parts = (msg as any).content ?? [];
    const newParts = parts.map((part: any) => {
      if (part.type === 'data' && part.mimeType?.startsWith('image/')) {
        return { type: 'text', value: `[Image Description: ${description}]` };
      }
      return part;
    });
    return { ...msg, content: newParts } as vscode.LanguageModelChatRequestMessage;
  }

  private removeImages(
    msg: vscode.LanguageModelChatRequestMessage,
  ): vscode.LanguageModelChatRequestMessage {
    const parts = (msg as any).content ?? [];
    const newParts = parts.filter(
      (part: any) => !(part.type === 'data' && part.mimeType?.startsWith('image/')),
    );
    return { ...msg, content: newParts } as vscode.LanguageModelChatRequestMessage;
  }

  /** Reset the cached model reference (called when visionModel config changes). */
  resetCache(): void {
    this.cachedModel = null;
  }
}
