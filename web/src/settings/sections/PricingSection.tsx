import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ModelProfile, PricingDocument } from "../../lib/contracts";
import { formatCurrency, formatDateTime, microToDecimal } from "../../lib/format";
import { useI18n } from "../../i18n";
import { useConfirmDialog } from "../../components/ConfirmDialog";

interface PricingForm {
  provider: string;
  model: string;
  currency: "USD" | "CNY";
  effectiveFrom: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

function localDateValue(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function emptyPricingForm(): PricingForm {
  return { provider: "", model: "", currency: "CNY", effectiveFrom: localDateValue(), input: "", output: "", cacheRead: "", cacheWrite: "" };
}

export function PricingSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const pricing = useQuery({ queryKey: ["model-pricing"], queryFn: api.modelPricing });
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState("");
  // 进入 JSON 编辑时的基线：dirty = 编辑中且内容已偏离基线（供对话框关闭/切页签前确认）
  const [jsonBaseline, setJsonBaseline] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  // 添加/编辑条目表单
  const [adding, setAdding] = useState(false);
  const [editingEntry, setEditingEntry] = useState<number | null>(null);
  const [form, setForm] = useState<PricingForm>(emptyPricingForm);
  // 模型选择器：从模型目录拉取 provider/model 建议
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const providerOptions = useMemo(
    () => Array.from(new Set((models.data ?? []).map((m: ModelProfile) => m.provider))).sort(),
    [models.data],
  );
  const modelOptions = useMemo(() => {
    const list = models.data ?? [];
    const provider = form.provider.trim();
    return Array.from(new Set((provider ? list.filter((m) => m.provider === provider) : list).map((m) => m.id))).sort();
  }, [models.data, form.provider]);

  const startEdit = (): void => {
    if (!pricing.data) return;
    const text = JSON.stringify(pricing.data, null, 2);
    setJson(text);
    setJsonBaseline(text);
    setError(undefined);
    setEditing(true);
  };

  // 向上汇报 JSON 编辑 dirty，供对话框关闭/切换页签前确认
  useEffect(() => { onDirtyChange?.(editing && json !== jsonBaseline); }, [editing, json, jsonBaseline, onDirtyChange]);

  const save = async (document: PricingDocument): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.saveModelPricing(document);
      setEditing(false);
      setAdding(false);
      setEditingEntry(null);
      void queryClient.invalidateQueries({ queryKey: ["model-pricing"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("保存失败", "Failed to save"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveJson = (): void => {
    let document: PricingDocument;
    try {
      document = JSON.parse(json) as PricingDocument;
    } catch {
      setError(t("JSON 解析失败，请检查格式。", "Could not parse JSON. Check its syntax."));
      return;
    }
    void save(document);
  };

  // 校验表单并将价格转 micro-units（×1000000），供添加/编辑共用
  const parseFormPrices = (): { provider: string; model: string; input: string; output: string; cacheRead: string; cacheWrite: string } | null => {
    const model = form.model.trim();
    const provider = form.provider.trim();
    if (!model || !provider) {
      setError(t("模型 id 与 provider 必填", "Model ID and provider are required"));
      return null;
    }
    if (!form.effectiveFrom) {
      setError(t("请选择生效日期", "Select an effective date"));
      return null;
    }
    const toMicro = (value: string, label: string, optional = false): string => {
      const trimmed = value.trim();
      if (!trimmed) {
        if (optional) return "0";
        throw new Error(t(`${label}必填`, `${label} is required`));
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) throw new Error(t(`${label}「${value}」无效`, `Invalid ${label}: ${value}`));
      return String(Math.round(num * 1_000_000));
    };
    try {
      return {
        provider,
        model,
        input: toMicro(form.input, t("输入单价", "input price")),
        output: toMicro(form.output, t("输出单价", "output price")),
        cacheRead: toMicro(form.cacheRead, t("缓存读单价", "cache-read price"), true),
        cacheWrite: toMicro(form.cacheWrite, t("缓存写单价", "cache-write price"), true),
      };
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : t("价格格式错误", "Invalid price format"));
      return null;
    }
  };

  const addEntry = (): void => {
    if (!pricing.data) return;
    const parsed = parseFormPrices();
    if (!parsed) return;
    const document: PricingDocument = {
      ...pricing.data,
      updatedAt: new Date().toISOString(),
      entries: [
        ...pricing.data.entries,
        {
          provider: parsed.provider,
          model: parsed.model,
          currency: form.currency as "USD" | "CNY",
          effectiveFrom: form.effectiveFrom,
          input: parsed.input,
          output: parsed.output,
          cacheRead: parsed.cacheRead,
          cacheWrite: parsed.cacheWrite,
        },
      ],
    };
    void save(document).then((saved) => {
      if (saved) setForm(emptyPricingForm());
    });
  };

  const startEditEntry = (index: number): void => {
    if (!pricing.data) return;
    const entry = pricing.data.entries[index];
    if (!entry) return;
    setForm({
      provider: entry.provider,
      model: entry.model,
      currency: entry.currency,
      effectiveFrom: entry.effectiveFrom,
      input: microToDecimal(entry.input),
      output: microToDecimal(entry.output),
      cacheRead: microToDecimal(entry.cacheRead),
      cacheWrite: microToDecimal(entry.cacheWrite),
    });
    setError(undefined);
    setAdding(false);
    setEditingEntry(index);
  };

  const saveEditEntry = (): void => {
    if (!pricing.data || editingEntry === null) return;
    const parsed = parseFormPrices();
    if (!parsed) return;
    const entries = [...pricing.data.entries];
    entries[editingEntry] = {
      provider: parsed.provider,
      model: parsed.model,
      currency: form.currency as "USD" | "CNY",
      effectiveFrom: form.effectiveFrom,
      input: parsed.input,
      output: parsed.output,
      cacheRead: parsed.cacheRead,
      cacheWrite: parsed.cacheWrite,
    };
    const document: PricingDocument = {
      ...pricing.data,
      updatedAt: new Date().toISOString(),
      entries,
    };
    void save(document).then((saved) => {
      if (saved) {
        setEditingEntry(null);
        setForm(emptyPricingForm());
      }
    });
  };

  const cancelForm = (): void => {
    setAdding(false);
    setEditingEntry(null);
    setError(undefined);
    setForm(emptyPricingForm());
  };

  const confirm = useConfirmDialog();

  const removeEntry = (index: number): void => {
    const data = pricing.data;
    const entry = data?.entries[index];
    if (!data || !entry) return;
    confirm.ask({
      title: t("删除定价", "Delete pricing"),
      body: t(`删除 ${entry.provider}/${entry.model} 的定价？`, `Delete pricing for ${entry.provider}/${entry.model}?`),
      confirmLabel: t("删除", "Delete"),
      onConfirm: () => {
        const document: PricingDocument = {
          ...data,
          updatedAt: new Date().toISOString(),
          entries: data.entries.filter((_, i) => i !== index),
        };
        void save(document);
      },
    });
  };

  const syncRemote = (): void => {
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    api.syncModelPricing()
      .then((result) => {
        if (!result.ok) {
          setError(result.error || t("远程定价同步失败", "Remote pricing sync failed"));
          return;
        }
        const updatedAt = formatDateTime(result.updatedAt, locale);
        setNotice(t(`已同步 ${result.count} 条远程定价 · ${updatedAt}`, `Synced ${result.count} remote pricing entries · ${updatedAt}`));
        void queryClient.invalidateQueries({ queryKey: ["model-pricing"] });
        void queryClient.invalidateQueries({ queryKey: ["models"] });
      })
      .catch((syncError: unknown) => setError(syncError instanceof Error ? syncError.message : t("远程定价同步失败", "Remote pricing sync failed")))
      .finally(() => setSaving(false));
  };

  if (pricing.isPending) return <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>;
  if (pricing.isError || !pricing.data) return <p className="muted-empty panel-empty">{t("无法加载定价目录。", "Could not load the pricing catalog.")}</p>;

  const document = pricing.data;
  return (
    <>
      <div className="pricing-head">
        <span className="settings-note">{t(`${document.entries.length} 条定价 · 每百万 tokens 单价 · 更新于 ${formatDateTime(document.updatedAt, locale)}`, `${document.entries.length} entries · price per million tokens · updated ${formatDateTime(document.updatedAt, locale)}`)}</span>
        {!editing && !adding && editingEntry === null && <button className="btn small" disabled={saving} onClick={syncRemote}>{saving ? t("同步中…", "Syncing…") : t("立即同步", "Sync now")}</button>}
        {!editing && !adding && editingEntry === null && <button className="btn small" onClick={() => { setForm(emptyPricingForm()); setError(undefined); setAdding(true); }}>{t("添加条目", "Add entry")}</button>}
        {!editing && !adding && editingEntry === null && <button className="btn small" onClick={startEdit}>{t("编辑 JSON", "Edit JSON")}</button>}
      </div>
      {notice && <p className="settings-note">{notice}</p>}
      {(adding || editingEntry !== null) && (
        <div className="pricing-add-form">
          <h4>{editingEntry !== null ? t("编辑定价条目", "Edit pricing entry") : t("添加定价条目", "Add pricing entry")}</h4>
          <p className="settings-note">{t("价格为每百万 tokens 单价（元/美元），保存时自动转 micro-units。", "Enter prices per million tokens (CNY/USD). Values are converted to micro-units when saved.")}</p>
          <div className="catalog-form">
            <input className="input" value={form.provider} placeholder="provider" aria-label="provider" list="pricing-provider-list" onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value }))} spellCheck={false} />
            <datalist id="pricing-provider-list">
              {providerOptions.map((p) => <option key={p} value={p} />)}
            </datalist>
            <input className="input" value={form.model} placeholder={t("模型 id", "Model ID")} aria-label={t("模型 id", "Model ID")} list="pricing-model-list" onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))} spellCheck={false} />
            <datalist id="pricing-model-list">
              {modelOptions.map((m) => <option key={m} value={m} />)}
            </datalist>
            <select className="input" value={form.currency} aria-label={t("币种", "Currency")} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value as PricingForm["currency"] }))}>
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
            <input className="input" type="date" value={form.effectiveFrom} aria-label={t("生效日期", "Effective date")} title={t("生效日期", "Effective date")} onChange={(e) => setForm((p) => ({ ...p, effectiveFrom: e.target.value }))} />
            <input className="input" type="number" min="0" step="any" value={form.input} placeholder={t("输入单价", "Input price")} aria-label={t("输入单价", "Input price")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, input: e.target.value }))} />
            <input className="input" type="number" min="0" step="any" value={form.output} placeholder={t("输出单价", "Output price")} aria-label={t("输出单价", "Output price")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, output: e.target.value }))} />
            <input className="input" type="number" min="0" step="any" value={form.cacheRead} placeholder={t("缓存读（可空）", "Cache read (optional)")} aria-label={t("缓存读", "Cache read")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, cacheRead: e.target.value }))} />
            <input className="input" type="number" min="0" step="any" value={form.cacheWrite} placeholder={t("缓存写（可空）", "Cache write (optional)")} aria-label={t("缓存写", "Cache write")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, cacheWrite: e.target.value }))} />
          </div>
          <div className="dialog-actions">
            <button className="btn" disabled={saving} onClick={cancelForm}>{t("取消", "Cancel")}</button>
            <button className="btn primary" disabled={saving} onClick={editingEntry !== null ? saveEditEntry : addEntry}>{saving ? t("保存中…", "Saving…") : editingEntry !== null ? t("保存", "Save") : t("添加", "Add")}</button>
          </div>
        </div>
      )}
      {editing ? (
        <>
          <textarea
            className="pricing-editor mono"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            aria-label={t("定价目录 JSON", "Pricing catalog JSON")}
            spellCheck={false}
          />
          {error && <p className="settings-error">{error}</p>}
          <div className="dialog-actions">
            <button className="btn" disabled={saving} onClick={() => setEditing(false)}>{t("取消", "Cancel")}</button>
            <button className="btn primary" disabled={saving} onClick={saveJson}>{saving ? t("保存中…", "Saving…") : t("保存定价", "Save pricing")}</button>
          </div>
        </>
      ) : (
        <>
          <div className="catalog-table-wrap">
          <table className="pricing-table">
            <thead>
              <tr><th>{t("模型", "Model")}</th><th>{t("服务商", "Provider")}</th><th>{t("币种", "Currency")}</th><th>{t("输入", "Input")}</th><th>{t("输出", "Output")}</th><th>{t("缓存读", "Cache read")}</th><th>{t("缓存写", "Cache write")}</th><th></th></tr>
            </thead>
            <tbody>
              {document.entries.map((entry, index) => (
                <tr key={`${entry.provider}/${entry.model}/${index}`}>
                  <td className="mono">{entry.model}</td>
                  <td>{entry.provider}</td>
                  <td>{entry.currency}</td>
                  <td className="mono">{entry.input ? formatCurrency(entry.input, entry.currency) : "—"}</td>
                  <td className="mono">{entry.output ? formatCurrency(entry.output, entry.currency) : "—"}</td>
                  <td className="mono">{entry.cacheRead ? formatCurrency(entry.cacheRead, entry.currency) : "—"}</td>
                  <td className="mono">{entry.cacheWrite ? formatCurrency(entry.cacheWrite, entry.currency) : "—"}</td>
                  <td><div className="pricing-row-actions"><button className="btn small" disabled={saving || editingEntry !== null || adding} onClick={() => startEditEntry(index)}>{t("编辑", "Edit")}</button><button className="btn small" disabled={saving || editingEntry !== null || adding} onClick={() => removeEntry(index)}>{t("删除", "Delete")}</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {error && <p className="settings-error">{error}</p>}
        </>
      )}
      {confirm.dialogElement}
    </>
  );
}
