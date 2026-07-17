export class ProviderRegistry {
    providers = new Map();
    register(provider) {
        if (this.providers.has(provider.name))
            throw new Error(`Provider ${provider.name} is already registered`);
        this.providers.set(provider.name, provider);
    }
    unregister(name) {
        this.providers.delete(name);
    }
    get(name) {
        return this.providers.get(name);
    }
    list() {
        return [...this.providers.keys()].sort();
    }
}
