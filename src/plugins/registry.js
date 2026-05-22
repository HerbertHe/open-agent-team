import { logger } from "../utils/logger";
export class PluginRegistry {
    static channels = new Map();
    static hooks = new Map();
    static manifests = new Map();
    static registerChannel(plugin) {
        this.channels.set(plugin.id, plugin);
    }
    static getChannel(id) {
        return this.channels.get(id);
    }
    static getRegisteredChannels() {
        return Array.from(this.channels.keys());
    }
    static registerManifest(id, manifest) {
        this.manifests.set(id, manifest);
    }
    static getManifest(id) {
        return this.manifests.get(id);
    }
    static getAllManifests() {
        return Array.from(this.manifests.values());
    }
    static unregisterPlugin(id) {
        this.channels.delete(id);
        this.manifests.delete(id);
    }
    static registerHook(name, callback) {
        if (!this.hooks.has(name)) {
            this.hooks.set(name, []);
        }
        this.hooks.get(name).push(callback);
    }
    static async triggerHook(name, ...args) {
        const list = this.hooks.get(name) || [];
        for (const callback of list) {
            try {
                await Promise.resolve(callback(...args));
            }
            catch (err) {
                logger.error(`Error in hook '${name}':`, { error: err.message });
            }
        }
    }
}
