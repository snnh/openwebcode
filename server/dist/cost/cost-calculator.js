export function calculateUsageCost(usage, pricing, exchangeRate) {
    validateUsage(usage);
    if (!pricing)
        return { priced: false };
    const weighted = BigInt(usage.inputTokens) * pricing.input +
        BigInt(usage.outputTokens) * pricing.output +
        BigInt(usage.cacheRead) * pricing.cacheRead +
        BigInt(usage.cacheWrite) * pricing.cacheWrite;
    const sourceMicroUnits = divideRounded(weighted, 1000000n);
    const source = {
        currency: pricing.currency,
        microUnits: sourceMicroUnits,
        amount: formatMicroUnits(sourceMicroUnits),
    };
    if (pricing.currency === "USD" && !exchangeRate) {
        return { priced: true, source, usd: amount("USD", sourceMicroUnits) };
    }
    if (pricing.currency === "CNY" && !exchangeRate) {
        return { priced: true, source, cny: amount("CNY", sourceMicroUnits) };
    }
    const converted = convert(sourceMicroUnits, pricing.currency, exchangeRate);
    if (converted === undefined)
        return { priced: true, source };
    const usdMicroUnits = pricing.currency === "USD" ? sourceMicroUnits : converted;
    const cnyMicroUnits = pricing.currency === "CNY" ? sourceMicroUnits : converted;
    return {
        priced: true,
        source,
        usd: amount("USD", usdMicroUnits),
        cny: amount("CNY", cnyMicroUnits),
        ...(exchangeRate ? { exchangeRate } : {}),
    };
}
export function formatMicroUnits(value) {
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / 1000000n;
    const fraction = (absolute % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
function amount(currency, microUnits) {
    return { currency, microUnits, amount: formatMicroUnits(microUnits) };
}
function convert(value, currency, rate) {
    if (!rate)
        return undefined;
    if (currency === "USD")
        return divideRounded(value * rate.rate, 1000000n);
    return divideRounded(value * 1000000n, rate.rate);
}
function divideRounded(numerator, denominator) {
    return (numerator + denominator / 2n) / denominator;
}
function validateUsage(usage) {
    const values = [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheRead,
        usage.cacheWrite,
    ];
    for (const value of values) {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("Usage token counts must be non-negative safe integers");
    }
}
