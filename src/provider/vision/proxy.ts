import * as vscode from 'vscode';
import type { VisionProxyStats } from '../../types';
import { Logger } from '../../logger';
import { SETTINGS_NS, IMAGE_DESCRIPTION_PROMPT } from '../../consts';

/**
 * Vision Proxy — resolves images by delegating to a vision-capable Copilot model.
 */
export class VisionProxy {
  private log: Logger;
  private cachedModel: vscode.LanguageModelChatInformation | null = null;

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

    // Find the last user message with images
    let latestImageUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if ((msg as any).role !== 'user') continue;
      const parts = (msg as any).content ?? [];
      const hasImages = parts.some(
        (p: any) => p.type === 'data' && p.mimeType?.startsWith('image/'),
      );
      if (hasImages) {
        latestImageUserIdx = i;
        break;
      }
    }

    // Count all image parts and messages
    for (const msg of messages) {
      const parts = (msg as any).content ?? [];
      const imageParts = parts.filter(
        (p: any) => p.type === 'data' && p.mimeType?.startsWith('image/'),
      );
      if (imageParts.length > 0) {
        stats.inputImageParts += imageParts.length;
        stats.inputImageMessages++;
      }
    }

    // Count current (latest) image messages
    for (let i = latestImageUserIdx; i >= 0 && i >= latestImageUserIdx; i--) {
      const msg = messages[i];
      if ((msg as any).role !== 'user') continue;
      const parts = (msg as any).content ?? [];
      const hasImages = parts.some(
        (p: any) => p.type === 'data' && p.mimeType?.startsWith('image/'),
      );
      if (hasImages) stats.currentImageMessages++;
    }

    // Count replayed (not latest) and historical
    for (let i = 0; i < latestImageUserIdx; i++) {
      const msg = messages[i];
      if ((msg as any).role !== 'user') continue;
      const parts = (msg as any).content ?? [];
      const hasImages = parts.some(
        (p: any) => p.type === 'data' && p.mimeType?.startsWith('image/'),
      );
      if (hasImages) {
        stats.replayedImageMessages++;
      }
    }

    // Omitted historical
    stats.omittedHistoricalMessages = stats.replayedImageMessages;

    // Images before the latest user message are dropped (their descriptions
    // only exist as text in previous assistant replies)
    const droppedImages: number[] = [];
    stats.droppedImageParts = 0;
    for (let i = 0; i < latestImageUserIdx; i++) {
      const msg = messages[i];
      if ((msg as any).role !== 'user') continue;
      const parts = (msg as any).content ?? [];
      const imageParts = parts.filter(
        (p: any) => p.type === 'data' && p.mimeType?.startsWith('image/'),
      );
      stats.droppedImageParts += imageParts.length;
      droppedImages.push(i);
    }

    // If no images to resolve, return early
    if (latestImageUserIdx < 0) {
      // Check for replay markers with vision text
      return { resolvedMessages: [...messages], stats };
    }

    // Resolve current images via vision proxy model
    try {
      const visionModel = await this.getVisionModel();
      if (visionModel) {
        const latestMsg = messages[latestImageUserIdx];
        const description = await this.describeImages(latestMsg, visionModel);
        if (description) {
          // Build resolved messages: replace latest user's images with text, drop historical image messages
          const resolvedMessages = messages.map((msg, idx) => {
            if (idx === latestImageUserIdx) {
              return this.replaceImagesWithText(msg, description);
            }
            if (droppedImages.includes(idx)) {
              // Keep the message but remove image parts
              return this.removeImages(msg);
            }
            return msg;
          });
          return { resolvedMessages, stats };
        }
      }
      stats.failedMessages++;
    } catch (err) {
      this.log.warn('Vision proxy failed:', err);
      stats.failedMessages++;
    }

    return { resolvedMessages: [...messages], stats };
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
