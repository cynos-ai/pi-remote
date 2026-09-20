import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { File as ExpoFile } from "expo-file-system";
import type {
  Attachment,
  CommandRequest,
  InteractionProjection,
  ModelInfo,
  ModelRef,
  ProjectSummary,
  RecoverableHistory,
  ReducerState,
  SessionSummary,
  Snapshot,
  TimelineItem
} from "@pi-remote/protocol";
import type { InteractionResponse } from "@pi-remote/protocol";
import {
  MobileApiError,
  PiRemoteApi,
  normalizeServerUrl,
  makeIdempotencyKey,
  type DeviceCredentials,
  type ProjectCreateRequest,
  type SessionCreateRequest
} from "./src/api/client";
import {
  appendPage,
  formatRelativeTime,
  mergeHistoryPage,
  offlineCacheLabel,
  projectActivityLabel,
  sessionStatusLabel,
  type SessionFilter
} from "./src/app-model";
import {
  activeRunId,
  applyRealtimeEvent,
  connectionStatusLabel,
  pendingInteractions,
  queuePauseLabel,
  recoveredInputs,
  snapshotFromState,
  stateFromSnapshot,
  timelineForDisplay,
  thinkingLevelsForModel,
  type SessionTimelineItem
} from "./src/session-model";
import { MobileRealtimeClient, type RealtimeStatus } from "./src/realtime";
import { accountCacheKey, type SecureCredentialsStore } from "./src/storage/credentials";
import {
  historyCacheKey,
  type MobileCache,
  openMobileCache,
  projectsCacheKey,
  sessionsCacheKey,
  snapshotCacheKey
} from "./src/storage/local-cache";
import { createSecureCredentialsStore } from "./src/storage/secure-store";

import { EditorSync } from "./src/editor-sync";
import { PendingCommands, type PendingCommand } from "./src/pending-commands";
import { applyExtensionNotice, emptyExtensionUi, type ExtensionUiState, type ExtensionNotice } from "./src/extension-ui";

type Screen = "projects" | "sessions" | "history";

function errorText(error: unknown): string {
  if (error instanceof MobileApiError) {
    if (error.code === "NETWORK_UNAVAILABLE") return "当前无法连接服务器，已显示本地缓存";
    if (error.code === "UNAUTHENTICATED" || error.code === "DEVICE_REVOKED") return "设备凭据已失效，请重新配对";
    if (error.code === "VERSION_CONFLICT") return "内容已被另一台设备修改，页面已刷新";
    if (error.code === "INVALID_SERVER_URL") return error.message;
    return error.message;
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function isCredentialError(error: unknown): boolean {
  return error instanceof MobileApiError && (error.code === "UNAUTHENTICATED" || error.code === "DEVICE_REVOKED");
}

function LoadingScreen({ message = "正在打开 pi-remote" }: { message?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.muted}>{message}</Text>
    </View>
  );
}

function NoticeBanner({ message, tone = "info" }: { message?: string | null; tone?: "info" | "error" }) {
  if (!message) return null;
  return (
    <View style={[styles.banner, tone === "error" ? styles.errorBanner : styles.infoBanner]}>
      <Text style={tone === "error" ? styles.errorText : styles.infoText}>{message}</Text>
    </View>
  );
}

function ActionButton({
  title,
  onPress,
  disabled = false,
  kind = "primary",
  testID
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "danger" | "quiet";
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        kind === "secondary" && styles.secondaryButton,
        kind === "danger" && styles.dangerButton,
        kind === "quiet" && styles.quietButton,
        disabled && styles.disabledButton,
        pressed && !disabled && styles.pressedButton
      ]}
    >
      <Text style={[
        styles.buttonText,
        kind === "secondary" && styles.secondaryButtonText,
        kind === "quiet" && styles.quietButtonText
      ]}>{title}</Text>
    </Pressable>
  );
}

function Field({
  value,
  onChangeText,
  placeholder,
  label,
  secureTextEntry = false,
  autoCapitalize = "sentences",
  keyboardType = "default",
  testID
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  label: string;
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  keyboardType?: "default" | "url";
  testID?: string;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        secureTextEntry={secureTextEntry}
        style={styles.input}
        testID={testID}
        value={value}
      />
    </View>
  );
}

function PageHeader({
  title,
  subtitle,
  onBack,
  right
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerMain}>
        {onBack ? <ActionButton title="‹ 返回" kind="quiet" onPress={onBack} /> : null}
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>{title}</Text>
          {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      {right}
    </View>
  );
}

function PairingScreen({
  initialMessage,
  onPaired
}: {
  initialMessage?: string | null;
  onPaired: (credentials: DeviceCredentials) => Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState("");
  const [pairingToken, setPairingToken] = useState("");
  const [deviceName, setDeviceName] = useState("我的手机");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialMessage ?? null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const api = new PiRemoteApi(normalizeServerUrl(serverUrl));
      const credentials = await api.pair(pairingToken.trim(), deviceName.trim() || "我的手机");
      await onPaired(credentials);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.pairingPage} keyboardShouldPersistTaps="handled">
        <View style={styles.brandMark}><Text style={styles.brandMarkText}>π</Text></View>
        <Text style={styles.heroTitle}>连接 pi-remote</Text>
        <Text style={styles.heroSubtitle}>使用服务器地址和一次性配对令牌连接你的开发环境。</Text>
        <NoticeBanner message={error} tone="error" />
        <Field
          autoCapitalize="none"
          keyboardType="url"
          label="服务器 HTTPS 地址"
          onChangeText={setServerUrl}
          placeholder="https://pi.example.com"
          testID="pair-server-url"
          value={serverUrl}
        />
        <Field
          autoCapitalize="none"
          label="一次性配对令牌"
          onChangeText={setPairingToken}
          placeholder="从服务器终端获取"
          secureTextEntry
          testID="pairing-token"
          value={pairingToken}
        />
        <Field
          label="设备名称"
          onChangeText={setDeviceName}
          placeholder="我的手机"
          testID="device-name"
          value={deviceName}
        />
        <ActionButton
          disabled={busy || serverUrl.trim().length === 0 || pairingToken.trim().length === 0}
          onPress={() => void submit()}
          testID="pair-submit"
          title={busy ? "正在配对…" : "安全配对"}
        />
        <Text style={styles.securityNote}>设备凭据只保存到系统 Keychain / Keystore，不写入普通缓存或日志。</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ProjectsScreen({
  api,
  cache,
  accountKey,
  onOpenProject,
  onSignOut
}: {
  api: PiRemoteApi;
  cache: MobileCache | null;
  accountKey: string;
  onOpenProject: (project: ProjectSummary) => void;
  onSignOut: () => Promise<void>;
}) {
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createRoot, setCreateRoot] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [saving, setSaving] = useState(false);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    const cached = await cache?.getResource<{ items: ProjectSummary[]; nextCursor: string | null }>(accountKey, projectsCacheKey());
    if (cached) {
      setItems(cached.value.items);
      setNextCursor(cached.value.nextCursor);
    }
    try {
      const page = await api.listProjects(null);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setOffline(null);
      await cache?.saveResource(accountKey, projectsCacheKey(), page, page.nextCursor);
    } catch (caught) {
      if (isCredentialError(caught)) setError(errorText(caught));
      else if (cached) setOffline(offlineCacheLabel(cached.updatedAt));
      else setError(errorText(caught));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accountKey, api, cache]);

  const loadMore = useCallback(async () => {
    if (loading || nextCursor === null) return;
    setLoading(true);
    try {
      const page = await api.listProjects(nextCursor);
      setItems((current) => {
        const merged = appendPage(current, page);
        void cache?.saveResource(accountKey, projectsCacheKey(), { items: merged, nextCursor: page.nextCursor }, page.nextCursor);
        return merged;
      });
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [accountKey, api, cache, loading, nextCursor]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  const createProject = async () => {
    setSaving(true);
    setError(null);
    const body: ProjectCreateRequest = { name: createName.trim(), rootPath: createRoot.trim() };
    try {
      await api.createProject(body);
      setCreateName("");
      setCreateRoot("");
      setShowCreate(false);
      await loadFirst();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const renameProject = async (project: ProjectSummary) => {
    const name = renameValue.trim();
    if (name.length === 0) return;
    setSaving(true);
    try {
      const response = await api.patchProject(project.id, { expectedVersion: project.version, name });
      const updated = response.project;
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRenameId(null);
    } catch (caught) {
      setError(errorText(caught));
      if (caught instanceof MobileApiError && caught.code === "VERSION_CONFLICT") await loadFirst();
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.flex}>
      <View style={styles.page}>
        <PageHeader
          title="项目"
          subtitle="选择一个 Linux 工作区"
          right={<ActionButton kind="quiet" onPress={() => void onSignOut()} title="退出" />}
        />
        <NoticeBanner message={offline} />
        <NoticeBanner message={error} tone="error" />
        {showCreate ? (
          <View style={styles.formCard}>
            <Text style={styles.cardTitle}>注册项目目录</Text>
            <Field label="项目名称" onChangeText={setCreateName} placeholder="例如：pi-remote" value={createName} />
            <Field autoCapitalize="none" label="Linux 目录" onChangeText={setCreateRoot} placeholder="/workspaces/pi-remote" value={createRoot} />
            <View style={styles.buttonRow}>
              <ActionButton disabled={saving} onPress={() => void createProject()} title={saving ? "保存中…" : "注册"} />
              <ActionButton kind="secondary" onPress={() => setShowCreate(false)} title="取消" />
            </View>
          </View>
        ) : (
          <ActionButton onPress={() => setShowCreate(true)} testID="project-create" title="＋ 注册项目" />
        )}
        {loading && items.length === 0 ? <LoadingScreen message="正在加载项目" /> : null}
        <FlatList
          contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
          data={items}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<Text style={styles.emptyText}>还没有项目。请先注册一个服务器上的目录。</Text>}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
          onRefresh={() => { setRefreshing(true); void loadFirst(); }}
          refreshing={refreshing}
          renderItem={({ item }) => (
            <View style={styles.card}>
              {renameId === item.id ? (
                <TextInput autoFocus onChangeText={setRenameValue} style={styles.inlineInput} value={renameValue} />
              ) : <Text style={styles.cardTitle}>{item.name}</Text>}
              <Text style={styles.cardMeta}>{projectActivityLabel(item)}</Text>
              {item.blockedReason ? <Text style={styles.warningText}>{item.blockedReason}</Text> : null}
              <View style={styles.buttonRow}>
                <ActionButton onPress={() => onOpenProject(item)} title="打开" />
                {renameId === item.id ? (
                  <>
                    <ActionButton disabled={saving} onPress={() => void renameProject(item)} title="保存" />
                    <ActionButton kind="secondary" onPress={() => setRenameId(null)} title="取消" />
                  </>
                ) : (
                  <ActionButton kind="secondary" onPress={() => { setRenameId(item.id); setRenameValue(item.name); }} title="改名" />
                )}
              </View>
            </View>
          )}
        />
      </View>
    </SafeAreaView>
  );
}

function SessionsScreen({
  api,
  cache,
  accountKey,
  project,
  onBack,
  onOpenSession
}: {
  api: PiRemoteApi;
  cache: MobileCache | null;
  accountKey: string;
  project: ProjectSummary;
  onBack: () => void;
  onOpenSession: (session: SessionSummary) => void;
}) {
  const [filter, setFilter] = useState<SessionFilter>("exclude");
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [recoverable, setRecoverable] = useState<RecoverableHistory[] | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<RecoverableHistory | null>(null);
  const [findingHistory, setFindingHistory] = useState(false);
  const importKeys = useRef(new Map<string, string>());
  const findHistory = async () => {
    setFindingHistory(true);
    setError(null);
    setSelectedHistory(null);
    try { setRecoverable((await api.listRecoverableHistory(project.id)).items); }
    catch (caught) { setError(errorText(caught)); }
    finally { setFindingHistory(false); }
  };
  const recoverHistory = async () => {
    if (!selectedHistory || saving) return;
    const keyId = `${project.id}:${selectedHistory.candidateId}`;
    const key = importKeys.current.get(keyId) ?? makeIdempotencyKey();
    importKeys.current.set(keyId, key);
    setSaving(true);
    setError(null);
    try {
      const response = await api.importHistory(project.id, selectedHistory.candidateId, key);
      setRecoverable(null);
      setSelectedHistory(null);
      onOpenSession(response.session);
    } catch (caught) { setError(errorText(caught)); }
    finally { setSaving(false); }
  };

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    const cacheKey = sessionsCacheKey(project.id, filter);
    const cached = await cache?.getResource<{ items: SessionSummary[]; nextCursor: string | null }>(accountKey, cacheKey);
    if (cached) {
      setItems(cached.value.items);
      setNextCursor(cached.value.nextCursor);
    } else {
      setItems([]);
      setNextCursor(null);
    }
    try {
      const page = await api.listSessions(project.id, filter, null);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setOffline(null);
      await cache?.saveResource(accountKey, cacheKey, page, page.nextCursor);
    } catch (caught) {
      if (isCredentialError(caught)) setError(errorText(caught));
      else if (cached) setOffline(offlineCacheLabel(cached.updatedAt));
      else setError(errorText(caught));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accountKey, api, cache, filter, project.id]);

  const loadMore = useCallback(async () => {
    if (loading || nextCursor === null) return;
    setLoading(true);
    try {
      const page = await api.listSessions(project.id, filter, nextCursor);
      setItems((current) => {
        const merged = appendPage(current, page);
        void cache?.saveResource(accountKey, sessionsCacheKey(project.id, filter), { items: merged, nextCursor: page.nextCursor }, page.nextCursor);
        return merged;
      });
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [accountKey, api, cache, filter, loading, nextCursor, project.id]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  const createSession = async () => {
    setSaving(true);
    setError(null);
    const body: SessionCreateRequest = createTitle.trim().length > 0 ? { title: createTitle.trim() } : {};
    try {
      await api.createSession(project.id, body);
      setCreateTitle("");
      setShowCreate(false);
      await loadFirst();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const renameSession = async (session: SessionSummary) => {
    const title = renameValue.trim();
    if (title.length === 0) return;
    setSaving(true);
    try {
      const response = await api.patchSession(session.id, { expectedVersion: session.version, title });
      const updated = response.session;
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRenameId(null);
    } catch (caught) {
      setError(errorText(caught));
      if (caught instanceof MobileApiError && caught.code === "VERSION_CONFLICT") await loadFirst();
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (session: SessionSummary) => {
    setSaving(true);
    try {
      await api.patchSession(session.id, { expectedVersion: session.version, archived: session.archivedAt === null });
      await loadFirst();
    } catch (caught) {
      setError(errorText(caught));
      if (isCredentialError(caught)) return;
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.flex}>
      <View style={styles.page}>
        <PageHeader onBack={onBack} title={project.name} subtitle="Session 历史与状态" />
        <NoticeBanner message={offline} />
        <NoticeBanner message={error} tone="error" />
        <View style={styles.segmented}>
          {(["exclude", "only", "all"] as const).map((value) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={value === "exclude" ? "当前会话" : value === "only" ? "已归档" : "全部会话"}
              key={value}
              onPress={() => setFilter(value)}
              style={[styles.segment, filter === value && styles.segmentActive]}
            >
              <Text style={filter === value ? styles.segmentTextActive : styles.segmentText}>
                {value === "exclude" ? "当前" : value === "only" ? "归档" : "全部"}
              </Text>
            </Pressable>
          ))}
        </View>
        {showCreate ? (
          <View style={styles.formCard}>
            <Text style={styles.cardTitle}>新建 Session</Text>
            <Field label="标题（可选）" onChangeText={setCreateTitle} placeholder="新会话" value={createTitle} />
            <View style={styles.buttonRow}>
              <ActionButton disabled={saving} onPress={() => void createSession()} title={saving ? "创建中…" : "创建"} />
              <ActionButton kind="secondary" onPress={() => setShowCreate(false)} title="取消" />
            </View>
          </View>
        ) : (
          <ActionButton onPress={() => setShowCreate(true)} testID="session-create" title="＋ 新建 Session" />
        )}
        <ActionButton disabled={saving || findingHistory} kind="secondary" onPress={() => void findHistory()} testID="history-discover" title={findingHistory ? "正在查找…" : "找回历史会话"} />
        {recoverable !== null ? (
          <View style={styles.formCard}>
            <Text style={styles.cardTitle}>可找回的历史</Text>
            <Text style={styles.cardMeta}>仅显示此项目尚未关联的有效历史。找回不会重发旧命令；继续对话时会保留原有上下文。消息列表从找回后开始记录。</Text>
            {recoverable.length === 0 ? <Text>没有找到可恢复的历史。</Text> : null}
            <ScrollView style={{ maxHeight: 200 }}>
              {recoverable.map(candidate => (
                <Pressable accessibilityRole="button" accessibilityLabel={`选择 ${candidate.title}`} disabled={saving} key={candidate.candidateId} onPress={() => setSelectedHistory(candidate)} style={styles.card}>
                  <Text style={styles.cardTitle}>{candidate.title}{selectedHistory?.candidateId === candidate.candidateId ? " · 已选择" : ""}</Text>
                  <Text style={styles.cardMeta}>{formatRelativeTime(candidate.modifiedAt)} · {candidate.entryCount} 条历史记录</Text>
                  <Text numberOfLines={2} style={styles.cardMeta}>{candidate.filename}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.buttonRow}>
              <ActionButton disabled={saving || !selectedHistory} onPress={() => void recoverHistory()} testID="history-import" title={saving ? "正在找回…" : "确认找回并打开"} />
              <ActionButton disabled={saving} kind="secondary" onPress={() => { setRecoverable(null); setSelectedHistory(null); }} title="取消" />
            </View>
          </View>
        ) : null}
        {loading && items.length === 0 ? <LoadingScreen message="正在加载 Session" /> : null}
        <FlatList
          contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
          data={items}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<Text style={styles.emptyText}>这个列表还没有 Session。</Text>}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
          onRefresh={() => { setRefreshing(true); void loadFirst(); }}
          refreshing={refreshing}
          renderItem={({ item }) => {
            const archived = item.archivedAt !== null;
            return (
              <View style={styles.card}>
                {renameId === item.id ? (
                  <TextInput autoFocus onChangeText={setRenameValue} style={styles.inlineInput} value={renameValue} />
                ) : <Text style={styles.cardTitle}>{item.title}</Text>}
                <Text style={styles.cardMeta}>{sessionStatusLabel(item)} · {formatRelativeTime(item.lastActivityAt ?? new Date().toISOString())}</Text>
                {item.lastMessagePreview ? <Text numberOfLines={2} style={styles.preview}>{item.lastMessagePreview}</Text> : null}
                <View style={styles.buttonRow}>
                  <ActionButton onPress={() => onOpenSession(item)} title="查看历史" />
                  {renameId === item.id ? (
                    <>
                      <ActionButton disabled={saving} onPress={() => void renameSession(item)} title="保存" />
                      <ActionButton kind="secondary" onPress={() => setRenameId(null)} title="取消" />
                    </>
                  ) : (
                    <ActionButton kind="secondary" onPress={() => { setRenameId(item.id); setRenameValue(item.title); }} title="改名" />
                  )}
                  <ActionButton
                    disabled={saving}
                    kind={archived ? "secondary" : "danger"}
                    onPress={() => void toggleArchive(item)}
                    title={archived ? "恢复" : "归档"}
                  />
                </View>
              </View>
            );
          }}
        />
      </View>
    </SafeAreaView>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.kind === "tool") {
    return (
      <View style={styles.timelineCard}>
        <Text style={styles.timelineTitle}>工具 · {item.data.toolName}</Text>
        <Text style={styles.codeText}>{item.data.output?.text ?? "等待工具输出"}</Text>
        {item.data.output?.truncated ? <Text style={styles.warningText}>输出已截断，可在后续版本打开 artifact。</Text> : null}
        {item.completeness === "partial" ? <Text style={styles.warningText}>工具在 {item.endReason} 状态中断，结果未知。</Text> : null}
      </View>
    );
  }
  return (
    <View style={styles.timelineCard}>
      <Text style={styles.timelineTitle}>{item.data.role === "assistant" ? "pi" : item.data.role === "user" ? "你" : item.data.role}</Text>
      {item.data.blocks.map((block, index) => {
        if (block.kind === "text" || block.kind === "thinking") {
          return (
            <Text key={`${item.itemId}-${index}`} style={block.kind === "thinking" ? styles.thinkingText : styles.timelineText}>
              {block.kind === "thinking" && !block.redacted ? "思考：" : ""}{block.text}
              {block.truncated ? "（已截断）" : ""}
            </Text>
          );
        }
        return (
          <Text key={`${item.itemId}-${index}`} style={styles.codeText}>
            工具调用 · {block.toolName}{"truncated" in block && block.truncated ? "（参数已截断）" : ""}
          </Text>
        );
      })}
      {item.data.bash ? <Text style={styles.codeText}>$ {item.data.bash.command}</Text> : null}
      {item.completeness === "partial" ? <Text style={styles.warningText}>消息已中断（{item.endReason}），未继续等待。</Text> : null}
    </View>
  );
}

export function HistoryScreen({
  api,
  cache,
  accountKey,
  session,
  onBack
}: {
  api: PiRemoteApi;
  cache: MobileCache | null;
  accountKey: string;
  session: SessionSummary;
  onBack: () => void;
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [atSeq, setAtSeq] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    const cachedHistory = await cache?.getResource<{ items: TimelineItem[]; atSeq: number }>(accountKey, historyCacheKey(session.id));
    const cachedSnapshot = await cache?.getResource<Snapshot>(accountKey, snapshotCacheKey(session.id));
    if (cachedHistory) {
      setItems(cachedHistory.value.items);
      setAtSeq(cachedHistory.value.atSeq);
      setNextCursor(cachedHistory.cursor);
    } else if (cachedSnapshot) {
      setItems(cachedSnapshot.value.items);
      setAtSeq(cachedSnapshot.value.snapshotSeq);
    }
    try {
      const snapshot = await api.getSnapshot(session.id);
      await cache?.saveResource(accountKey, snapshotCacheKey(session.id), snapshot, snapshot.historyCursor);
      let page;
      try {
        page = await api.getHistory(session.id, null);
      } catch (historyError) {
        setItems(snapshot.items);
        setAtSeq(snapshot.snapshotSeq);
        setNextCursor(snapshot.historyCursor);
        setError(isCredentialError(historyError)
          ? errorText(historyError)
          : `历史分页暂不可用，当前快照仍可读：${errorText(historyError)}`);
        return;
      }
      setItems(page.items);
      setAtSeq(page.atSeq);
      setNextCursor(page.nextCursor);
      setOffline(null);
      await cache?.saveResource(accountKey, historyCacheKey(session.id), { items: page.items, atSeq: page.atSeq }, page.nextCursor);
    } catch (caught) {
      if (isCredentialError(caught)) {
        setError(errorText(caught));
      } else if (cachedHistory || cachedSnapshot) {
        const updatedAt = Math.max(cachedHistory?.updatedAt ?? 0, cachedSnapshot?.updatedAt ?? 0);
        setOffline(offlineCacheLabel(updatedAt));
      } else {
        setError(errorText(caught));
      }
    } finally {
      setLoading(false);
    }
  }, [accountKey, api, cache, session.id]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  const loadMore = async () => {
    if (loadingMore || nextCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await api.getHistory(session.id, nextCursor);
      setItems((current) => {
        const merged = mergeHistoryPage(current, page);
        void cache?.saveResource(accountKey, historyCacheKey(session.id), { items: merged, atSeq: page.atSeq }, page.nextCursor);
        return merged;
      });
      setAtSeq(page.atSeq);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <SafeAreaView style={styles.flex}>
      <View style={styles.page}>
        <PageHeader onBack={onBack} title={session.title} subtitle={`${sessionStatusLabel(session)} · seq ${atSeq}`} />
        <NoticeBanner message={offline} />
        <NoticeBanner message={error} tone="error" />
        {loading && items.length === 0 ? <LoadingScreen message="正在读取快照与历史" /> : null}
        <FlatList
          contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
          data={items}
          keyExtractor={(item) => item.itemId}
          ListEmptyComponent={<Text style={styles.emptyText}>这个 Session 还没有可显示的历史。</Text>}
          ListFooterComponent={nextCursor ? <ActionButton disabled={loadingMore} kind="secondary" onPress={() => void loadMore()} title={loadingMore ? "加载中…" : "加载更早记录"} /> : null}
          renderItem={({ item }) => <TimelineRow item={item} />}
        />
      </View>
    </SafeAreaView>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "不可显示的内容";
  }
}

function interactionOriginLabel(origin: InteractionProjection["origin"]): string {
  switch (origin) {
    case "initialize": return "初始化";
    case "configure": return "配置";
    case "run": return "运行";
    case "bash": return "Bash";
    case "extension": return "扩展";
  }
}

function interactionKindLabel(kind: InteractionProjection["kind"]): string {
  switch (kind) {
    case "select": return "选择";
    case "confirm": return "确认";
    case "input": return "输入";
    case "editor": return "编辑";
  }
}

function ExtensionWidgets({ ui, placement }: { ui: ExtensionUiState; placement: "aboveEditor" | "belowEditor" }) {
  return <>{Object.entries(ui.widgets).filter(([key]) => (ui.widgetPlacements[key] ?? "aboveEditor") === placement).map(([key, lines]) =>
    <View key={key} style={styles.formCard}><Text style={styles.fieldLabel}>{key}</Text><Text selectable style={styles.codeText}>{lines.join("\n")}</Text></View>)}</>;
}

function ExtensionWorkingRow({ ui, active }: { ui: ExtensionUiState; active: boolean }) {
  const [frame, setFrame] = useState(0);
  const indicator = ui.workingIndicator;
  useEffect(() => {
    setFrame(0);
    if (!active || !ui.workingVisible || !indicator || indicator.frames.length < 2) return;
    const timer = setInterval(() => setFrame(current => (current + 1) % indicator.frames.length), indicator.intervalMs);
    return () => clearInterval(timer);
  }, [active, indicator, ui.workingVisible]);
  if (!active || !ui.workingVisible) return null;
  return <View style={styles.buttonRow} accessibilityRole="progressbar" accessibilityLabel={ui.workingMessage || "处理中"}>
    {indicator === null ? <ActivityIndicator /> : <Text>{indicator.frames[frame % Math.max(1, indicator.frames.length)] ?? ""}</Text>}
    <Text style={styles.infoText}>{ui.workingMessage || "处理中…"}</Text>
  </View>;
}

function ExecutionTimelineRow({ item, ui }: { item: SessionTimelineItem; ui: ExtensionUiState }) {
  const [expanded, setExpanded] = useState(ui.toolsExpanded);
  useEffect(() => { setExpanded(ui.toolsExpanded); }, [ui.toolsExpanded, ui.toolsExpansionSeq]);
  if (item.kind === "message" && item.data.custom && !item.data.custom.display) return null;
  const live = "displayState" in item;
  const completeness = live ? "live" : item.completeness;
  if (item.kind === "tool") {
    return (
      <View style={styles.timelineCard}>
        <View style={styles.timelineHeadingRow}>
          <Text style={styles.timelineTitle}>工具 · {item.data.toolName}</Text>
          <Text style={live ? styles.liveBadge : styles.cardMeta}>
            {live ? "实时" : item.completeness === "partial" ? "结果未知" : item.data.isError ? "错误" : "完成"}
          </Text>
        </View>
        <Text style={styles.toolMeta}>调用归属 · {item.operationId}{item.runId ? ` · Run ${item.runId}` : " · 独立内容"}</Text>
        {expanded ? <Text style={styles.codeText}>{safeJson(item.data.args)}</Text> : null}
        <Text numberOfLines={expanded ? undefined : 3} style={styles.codeText}>{item.data.output?.text ?? "等待工具输出"}</Text>
        <ActionButton kind="secondary" onPress={() => setExpanded(current => !current)} title={expanded ? "收起输出" : "展开输出"} />
        {item.data.output?.truncated ? <Text style={styles.warningText}>展示副本已截断，原始 artifact 仍由服务器保留。</Text> : null}
        {!live && item.completeness === "partial" ? <Text style={styles.warningText}>工具在 {item.endReason} 状态中断，执行结果未知。</Text> : null}
        {item.data.isError ? <Text style={styles.errorText}>工具返回错误，后续模型可继续处理。</Text> : null}
      </View>
    );
  }
  const role = item.data.role === "assistant" ? "pi" : item.data.role === "user" ? "你" : item.data.role;
  return (
    <View style={styles.timelineCard}>
      <View style={styles.timelineHeadingRow}>
        <Text style={styles.timelineTitle}>{role}</Text>
        <Text style={live ? styles.liveBadge : styles.cardMeta}>
          {live ? "流式中" : completeness === "partial" ? "已中断" : "已记录"}
        </Text>
      </View>
      <Text style={styles.toolMeta}>Operation · {item.operationId}{item.runId ? ` · Run ${item.runId}` : " · 无 Run 内容"}</Text>
      {item.data.blocks.map((block, index) => {
        if (block.kind === "text" || block.kind === "thinking") {
          return (
            <Text key={`${item.itemId}-${index}`} style={block.kind === "thinking" ? styles.thinkingText : styles.timelineText}>
              {block.kind === "thinking" ? block.redacted ? ui.hiddenThinkingLabel : `思考：${block.text}` : block.text}
              {block.truncated ? "（展示副本已截断）" : ""}
            </Text>
          );
        }
        return (
          <View key={`${item.itemId}-${index}`} style={styles.toolCallBlock}>
            <Text style={styles.codeText}>
              工具调用 · {block.toolName}{"argumentsText" in block ? "（参数仍在生成）" : block.truncated ? "（参数已截断）" : ""}
            </Text>
            {"argumentsText" in block ? <Text style={styles.codeText}>{block.argumentsText}</Text> : null}
          </View>
        );
      })}
      {item.data.bash ? (
        <>
          <Text style={styles.codeText}>$ {item.data.bash.command}</Text>
          <Text style={styles.toolMeta}>
            {item.data.bash.excludeFromContext ? "!! · 不写入模型上下文" : "! · 写入模型上下文"} · {item.data.bash.outcome}
          </Text>
        </>
      ) : null}
      {item.data.custom ? <Text style={styles.toolMeta}>自定义消息 · {item.data.custom.type}</Text> : null}
      {!live && item.completeness === "partial" ? <Text style={styles.warningText}>消息已中断（{item.endReason}），已停止等待，不会伪造完成。</Text> : null}
    </View>
  );
}

function InteractionCard({
  interaction,
  customLines,
  busy,
  onRespond
}: {
  interaction: InteractionProjection;
  customLines?: string[];
  busy: boolean;
  onRespond: (interaction: InteractionProjection, response: InteractionResponse) => Promise<void>;
}) {
  const [value, setValue] = useState(interaction.prefill ?? "");
  const expired = interaction.expiresAt !== undefined && Date.parse(interaction.expiresAt) <= Date.now();
  useEffect(() => { setValue(interaction.prefill ?? ""); }, [interaction.interactionId, interaction.prefill]);
  const disabled = busy || expired;
  const answer = (response: InteractionResponse) => { void onRespond(interaction, response); };
  return (
    <View style={styles.interactionCard}>
      <View style={styles.timelineHeadingRow}>
        <Text style={styles.cardTitle}>{interaction.title}</Text>
        <Text style={expired ? styles.warningText : styles.liveBadge}>{expired ? "已到期" : "待回答"}</Text>
      </View>
      <Text style={styles.toolMeta}>
        {interactionOriginLabel(interaction.origin)} · {interactionKindLabel(interaction.kind)} · Operation {interaction.operationId}
      </Text>
      {interaction.message ? <Text style={styles.timelineText}>{interaction.message}</Text> : null}
      {customLines ? <Text selectable style={styles.codeText}>{customLines.join("\n")}</Text> : null}
      {interaction.kind === "select" ? (
        <View style={styles.optionList}>
          {(interaction.options ?? []).map((option) => (
            <ActionButton
              disabled={disabled}
              key={option.value}
              kind="secondary"
              onPress={() => answer({ value: option.value })}
              title={option.label}
            />
          ))}
        </View>
      ) : null}
      {interaction.kind === "confirm" ? (
        <View style={styles.buttonRow}>
          <ActionButton disabled={disabled} onPress={() => answer({ confirmed: true })} title="确认" />
          <ActionButton disabled={disabled} kind="secondary" onPress={() => answer({ confirmed: false })} title="取消" />
        </View>
      ) : null}
      {interaction.kind === "input" || interaction.kind === "editor" ? (
        <>
          <TextInput
            editable={!disabled}
            multiline={interaction.kind === "editor"}
            onChangeText={setValue}
            placeholder={interaction.placeholder}
            placeholderTextColor={colors.placeholder}
            style={interaction.kind === "editor" ? styles.editorInput : styles.input}
            value={value}
          />
          <View style={styles.buttonRow}>
            <ActionButton disabled={disabled} onPress={() => answer({ value })} title="提交一次性回答" />
            <ActionButton disabled={disabled} kind="secondary" onPress={() => answer({ cancelled: true })} title="取消" />
          </View>
        </>
      ) : null}
      {interaction.kind === "select" ? <ActionButton disabled={disabled} kind="quiet" onPress={() => answer({ cancelled: true })} title="取消这次请求" /> : null}
    </View>
  );
}

function ExecutionScreen({
  api,
  cache,
  accountKey,
  session,
  onBack,
  onCreatedSession
}: {
  api: PiRemoteApi;
  cache: MobileCache | null;
  accountKey: string;
  session: SessionSummary;
  onBack: () => void;
  onCreatedSession: (session: SessionSummary) => void;
}) {
  const editorSync = useMemo(() => new EditorSync((text) => api.syncEditorState(session.id, text)), [api, session.id]);
  const pendingStore = useMemo(() => cache ? new PendingCommands(cache, accountKey, api, (text) => editorSync.update(text)) : null, [cache, accountKey, api, editorSync]);
  const [pendingSubmits, setPendingSubmits] = useState<PendingCommand[]>([]);
  const submissionLock = useRef(false);
  const [explicitNew, setExplicitNew] = useState(false);
  const [extensionUi, setExtensionUi] = useState(emptyExtensionUi);
  const extensionUiRef = useRef(emptyExtensionUi());
  const [composerText, setComposerText] = useState("");
  const updateEditor = (text: string) => {
    setComposerText(text);
    extensionUiRef.current = { ...extensionUiRef.current, editorText: text };
    void cache?.saveResource(accountKey, `extension-ui:${session.id}`, extensionUiRef.current).catch((caught) => setError(errorText(caught)));
  };
  const consumeNotices = useCallback(async (notices: readonly ExtensionNotice[]) => {
    let next = extensionUiRef.current;
    for (const notice of notices) next = applyExtensionNotice(next, notice);
    if (next === extensionUiRef.current) return;
    const editorChanged = next.editorText !== extensionUiRef.current.editorText;
    extensionUiRef.current = next;
    setExtensionUi(next);
    if (editorChanged) setComposerText(next.editorText);
    await cache?.saveResource(accountKey, `extension-ui:${session.id}`, next);
  }, [cache, accountKey, session.id]);

  const [clientState, setClientState] = useState<ReducerState | null>(null);
  const clientStateRef = useRef<ReducerState | null>(null);
  const [historyItems, setHistoryItems] = useState<TimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyAtSeq, setHistoryAtSeq] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realtimeNotice, setRealtimeNotice] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("stopped");
  const [lastCommandId, setLastCommandId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [allowedCommands, setAllowedCommands] = useState<Array<CommandRequest["kind"]>>(["prompt", "follow_up"]);
  const snapshotModelRef = useRef<ModelRef | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [capabilities, setCapabilities] = useState<Awaited<ReturnType<PiRemoteApi["getCapabilities"]>> | null>(null);
  const snapshotOptionsRef = useRef<Pick<Snapshot, "historyCursor" | "availableThinkingLevels" | "allowedCommands">>({
    historyCursor: null,
    availableThinkingLevels: [],
    allowedCommands: ["prompt", "follow_up"]
  });
  const realtimeRef = useRef<MobileRealtimeClient | null>(null);

  const applySnapshot = useCallback(async (snapshot: Snapshot): Promise<void> => {
    const current = clientStateRef.current;
    if (current?.sessionId === snapshot.session.id && current.lastSeq > snapshot.snapshotSeq) return;
    const next = stateFromSnapshot(snapshot);
    snapshotOptionsRef.current = {
      historyCursor: snapshot.historyCursor,
      availableThinkingLevels: [...snapshot.availableThinkingLevels],
      allowedCommands: [...snapshot.allowedCommands]
    };
    clientStateRef.current = next;
    setClientState(next);
    setHistoryAtSeq(snapshot.snapshotSeq);
    snapshotModelRef.current = snapshot.session.model;
    setThinkingLevels([...snapshot.availableThinkingLevels]);
    setAllowedCommands([...snapshot.allowedCommands]);
    await consumeNotices(next.notices);
    await cache?.saveResource(accountKey, snapshotCacheKey(session.id), snapshot, String(snapshot.snapshotSeq));
  }, [accountKey, cache, session.id, consumeNotices]);

  const fetchSnapshot = useCallback(() => api.getSnapshot(session.id), [api, session.id]);

  const loadCatalog = useCallback(async (refresh = false) => {
    const [capabilityResult, modelsResult] = await Promise.allSettled([api.getCapabilities(), api.getModels(session.id, refresh)]);
    if (capabilityResult.status === "fulfilled") setCapabilities(capabilityResult.value);
    else if (isCredentialError(capabilityResult.reason)) setError(errorText(capabilityResult.reason));
    if (modelsResult.status === "fulfilled") setModels(modelsResult.value.items);
    else setError(`模型目录刷新失败：${errorText(modelsResult.reason)}`);
  }, [api, session.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        setPendingSubmits(await pendingStore?.list(session.id) ?? []);
        const cachedUi = await cache?.getResource<ExtensionUiState>(accountKey, `extension-ui:${session.id}`);
        if (active && cachedUi) {
          extensionUiRef.current = { ...emptyExtensionUi(), ...cachedUi.value };
          setExtensionUi(extensionUiRef.current);
          setComposerText(cachedUi.value.editorText);
        }
      } catch (caught) { if (active) setError(errorText(caught)); }
      const cachedSnapshot = await cache?.getResource<Snapshot>(accountKey, snapshotCacheKey(session.id));
      const cachedHistory = await cache?.getResource<{ items: TimelineItem[]; atSeq: number }>(accountKey, historyCacheKey(session.id));
      if (active && cachedSnapshot) {
        await applySnapshot(cachedSnapshot.value);
        setOffline(offlineCacheLabel(cachedSnapshot.updatedAt));
      }
      if (active && cachedHistory) {
        setHistoryItems(cachedHistory.value.items);
        setHistoryAtSeq(cachedHistory.value.atSeq);
        setNextCursor(cachedHistory.cursor);
      } else if (active && cachedSnapshot) {
        setHistoryItems(cachedSnapshot.value.items);
        setNextCursor(cachedSnapshot.value.historyCursor);
      }
      try {
        const snapshot = await fetchSnapshot();
        if (!active) return;
        await applySnapshot(snapshot);
        setOffline(null);
        try {
          const page = await api.getHistory(session.id, null);
          if (!active) return;
          setHistoryItems(page.items);
          setHistoryAtSeq(page.atSeq);
          setNextCursor(page.nextCursor);
          await cache?.saveResource(accountKey, historyCacheKey(session.id), { items: page.items, atSeq: page.atSeq }, page.nextCursor);
        } catch (historyError) {
          if (active) setError(`历史分页暂不可用，当前实时快照仍可读：${errorText(historyError)}`);
        }
      } catch (caught) {
        if (!active) return;
        if (isCredentialError(caught)) setError(errorText(caught));
        else if (cachedSnapshot || cachedHistory) {
          const updatedAt = Math.max(cachedSnapshot?.updatedAt ?? 0, cachedHistory?.updatedAt ?? 0);
          setOffline(offlineCacheLabel(updatedAt));
        } else setError(errorText(caught));
      } finally {
        if (active) {
          setReady(clientStateRef.current !== null);
          setLoading(false);
        }
      }
    })();
    void loadCatalog();
    return () => { active = false; };
  }, [accountKey, api, applySnapshot, cache, fetchSnapshot, loadCatalog, pendingStore, session.id]);

  useEffect(() => {
    if (!ready || clientStateRef.current === null) return;
    const realtime = new MobileRealtimeClient({
      api,
      sessionId: session.id,
      cursor: clientStateRef.current.lastSeq,
      loadSnapshot: fetchSnapshot,
      onSnapshot: async (snapshot) => {
        await applySnapshot(snapshot);
        setOffline(null);
      },
      onEvent: async (event) => {
        const current = clientStateRef.current;
        if (!current) return;
        const next = applyRealtimeEvent(current, event);
        await consumeNotices(next.notices);
        if (event.type === "session.updated") void loadCatalog();
        clientStateRef.current = next;
        setClientState(next);
        setHistoryAtSeq(next.lastSeq);
        const cached = snapshotFromState(next, snapshotOptionsRef.current);
        await cache?.saveResource(accountKey, snapshotCacheKey(session.id), cached, String(next.lastSeq));
      },
      onStatus: (status) => {
        setRealtimeStatus(status);
        if (status === "connected") {
          setOffline(null);
          setRealtimeNotice(null);
        } else if (status === "backing_off") {
          setRealtimeNotice("实时连接已断开，任务仍由服务器继续执行；回到前台或连接恢复后会自动补回事件。");
        }
      },
      onError: (caught) => {
        if (isCredentialError(caught)) setError(errorText(caught));
        else if (caught instanceof MobileApiError && caught.code === "NETWORK_UNAVAILABLE") {
          setRealtimeNotice("实时连接暂不可用，正在按退避策略重试；不会自动确认待答表单。");
        } else if (caught instanceof Error && caught.message.length > 0) setRealtimeNotice(caught.message);
      }
    });
    realtimeRef.current = realtime;
    realtime.start();
    if (AppState.currentState !== "active") realtime.setAppActive(false);
    const subscription = AppState.addEventListener("change", (state) => realtime.setAppActive(state === "active"));
    return () => {
      subscription.remove();
      realtime.stop();
      realtimeRef.current = null;
    };
  }, [accountKey, api, applySnapshot, cache, fetchSnapshot, ready, session.id, consumeNotices, loadCatalog]);

  const refresh = async () => {
    setActionBusy(true);
    setError(null);
    try {
      const snapshot = await fetchSnapshot();
      await applySnapshot(snapshot);
      await loadCatalog();
      const page = await api.getHistory(session.id, null);
      setHistoryItems(page.items);
      setHistoryAtSeq(page.atSeq);
      setNextCursor(page.nextCursor);
      await cache?.saveResource(accountKey, historyCacheKey(session.id), { items: page.items, atSeq: page.atSeq }, page.nextCursor);
      setOffline(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const submitCommand = useCallback(async (command: CommandRequest, original?: PendingCommand, newSubmission = false): Promise<boolean> => {
    if (submissionLock.current) return false;
    submissionLock.current = true;
    setActionBusy(true);
    setError(null);
    try {
      if (!pendingStore) throw new Error("本地持久存储不可用，未发送命令");
      const existing = await pendingStore.list(session.id);
      const entry = original ?? (!newSubmission ? existing.find((item) => JSON.stringify(item.command) === JSON.stringify(command)) : undefined)
        ?? await pendingStore.prepare(session.id, command, extensionUiRef.current.editorText);
      setPendingSubmits(await pendingStore.list(session.id));
      const receipt = await pendingStore.reconcile(entry);
      setLastCommandId(receipt.commandId);
      setPendingSubmits(await pendingStore.list(session.id));
      // Receipt acknowledgment is final even if the subsequent refresh fails.
      if (receipt.state === "completed") {
        try { await applySnapshot(await fetchSnapshot()); await loadCatalog(); }
        catch (caught) { setError(errorText(caught)); }
      }
      return true;
    } catch (caught) {
      setError(errorText(caught));
      try { setPendingSubmits(await pendingStore?.list(session.id) ?? []); } catch { /* Preserve the last visible pending identities. */ }
      return false;
    } finally {
      submissionLock.current = false;
      setActionBusy(false);
    }
  }, [pendingStore, editorSync, applySnapshot, fetchSnapshot, loadCatalog, session.id]);

  const state = clientState;
  const activeId = state ? activeRunId(state) : null;
  const bashActive = state ? Object.values(state.operations).some((operation) => operation.kind === "bash" && (operation.status === "running" || operation.status === "waiting_input")) : false;
  const [composerMode, setComposerMode] = useState<"prompt" | "bash" | "extension">("prompt");
  const [sendMode, setSendMode] = useState<"prompt" | "steer" | "follow_up">("prompt");
  const [bashExcludeFromContext, setBashExcludeFromContext] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentNames, setAttachmentNames] = useState<string[]>([]);
  const [attachmentArtifactId, setAttachmentArtifactId] = useState("");
  const [attachmentMimeType, setAttachmentMimeType] = useState("image/png");
  const [showMenu, setShowMenu] = useState(false);
  const [showModelForm, setShowModelForm] = useState(false);
  const [modelProvider, setModelProvider] = useState(state?.session.model?.provider ?? "");
  const [modelId, setModelId] = useState(state?.session.model?.id ?? "");
  const [persistModel, setPersistModel] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [renameValue, setRenameValue] = useState(state?.session.title ?? session.title);
  const [showNewSession, setShowNewSession] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState("");

  useEffect(() => {
    if (!state) return;
    setModelProvider(state.session.model?.provider ?? "");
    setModelId(state.session.model?.id ?? "");
    setRenameValue(state.session.title);
  }, [state?.session.model?.provider, state?.session.model?.id, state?.session.title]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void editorSync.update(extensionUiRef.current.editorText).catch((caught) => setError(`编辑器同步失败：${errorText(caught)}`));
    }, 250);
    return () => clearTimeout(timer);
  }, [composerText, editorSync, ready]);

  const canRun = (kind: CommandRequest["kind"]): boolean => allowedCommands.includes(kind);

  const pickAttachments = async () => {
    setActionBusy(true);
    setError(null);
    try {
      const result = await ExpoFile.pickFileAsync({ multipleFiles: true, mimeTypes: ["image/*"] });
      if (result.canceled) return;
      const files = Array.isArray(result.result) ? result.result : [result.result];
      const uploaded: Array<{ attachment: Attachment; name: string }> = [];
      for (const file of files) {
        const mimeType = file.type || "application/octet-stream";
        const artifact = await api.uploadArtifact(session.id, { body: file, mimeType });
        uploaded.push({ attachment: { artifactId: artifact.id, mimeType: artifact.mimeType }, name: file.name });
      }
      setAttachments((current) => [...current, ...uploaded.map((item) => item.attachment)]);
      setAttachmentNames((current) => [...current, ...uploaded.map((item) => item.name)]);
    } catch (caught) {
      setError(`附件选择或上传失败：${errorText(caught)}`);
    } finally {
      setActionBusy(false);
    }
  };

  const sendComposer = async () => {
    const text = composerText.trim();
    if (text.length === 0 || !state) return;
    const selectedAttachments = [
      ...attachments,
      ...(attachmentArtifactId.trim().length > 0
      ? [{ artifactId: attachmentArtifactId.trim(), mimeType: attachmentMimeType.trim() || "application/octet-stream" }]
      : [])
    ];
    const attachment = selectedAttachments.length > 0 ? selectedAttachments : undefined;
    let command: CommandRequest;
    if (composerMode === "bash") {
      command = { kind: "bash", payload: { command: text, excludeFromContext: bashExcludeFromContext } };
    } else if (composerMode === "extension") {
      command = { kind: "extension_command", payload: { text } };
    } else if (sendMode === "follow_up") {
      command = { kind: "follow_up", payload: { text, ...(attachment ? { attachments: attachment } : {}) } };
    } else {
      command = {
        kind: "prompt",
        payload: {
          text,
          ...(attachment ? { attachments: attachment } : {}),
          ...(activeId && sendMode === "steer" ? { streamingBehavior: "steer" as const } : {})
        }
      };
    }
    if (!canRun(command.kind)) {
      setError("当前服务器能力清单未开放此入口，未发送请求。");
      return;
    }
    if (await submitCommand(command, undefined, explicitNew)) {
      if (extensionUiRef.current.editorText === composerText) updateEditor("");
      setExplicitNew(false);
      setAttachments([]);
      setAttachmentNames([]);
      setAttachmentArtifactId("");
    }
  };

  const respondToInteraction = async (interaction: InteractionProjection, response: InteractionResponse) => {
    setRespondingId(interaction.interactionId);
    await submitCommand({
      kind: "respond",
      payload: { interactionId: interaction.interactionId, operationId: interaction.operationId, response }
    });
    setRespondingId(null);
  };

  const setModel = async (model: ModelRef) => {
    if (!state) return;
    const ok = await submitCommand({ kind: "set_model", payload: { expectedVersion: state.session.version, model, persist: persistModel } });
    if (ok) setShowModelForm(false);
  };

  const setThinking = async (level: string) => {
    if (!state) return;
    await submitCommand({ kind: "set_thinking", payload: { expectedVersion: state.session.version, level, persist: false } });
  };

  const renameSession = async () => {
    if (!state || renameValue.trim().length === 0) return;
    setActionBusy(true);
    setError(null);
    try {
      await api.patchSession(session.id, { expectedVersion: state.session.version, title: renameValue.trim() });
      await applySnapshot(await fetchSnapshot());
      setShowRename(false);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!state) return;
    setActionBusy(true);
    setError(null);
    try {
      await api.patchSession(session.id, { expectedVersion: state.session.version, archived: state.session.archivedAt === null });
      await applySnapshot(await fetchSnapshot());
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const createSession = async () => {
    setActionBusy(true);
    setError(null);
    try {
      const created = await api.createSession(session.projectId, newSessionTitle.trim().length > 0 ? { title: newSessionTitle.trim() } : {});
      setNewSessionTitle("");
      setShowNewSession(false);
      onCreatedSession(created.session);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setActionBusy(false);
    }
  };

  const items = state ? timelineForDisplay(state, historyItems) : [];
  const interactions = state ? pendingInteractions(state) : [];
  const drafts = state ? recoveredInputs(state) : [];
  const pauseLabel = state ? queuePauseLabel(state) : null;
  const statusText = state ? sessionStatusLabel(state.session) : "正在加载";
  const currentThinkingLevels = thinkingLevelsForModel(state?.session.model ?? null, models, snapshotModelRef.current, thinkingLevels);
  const modelText = state?.session.model ? `${state.session.model.provider}/${state.session.model.id}` : "未配置模型";

  const loadMore = async () => {
    if (loadingMore || nextCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await api.getHistory(session.id, nextCursor);
      setHistoryItems((current) => {
        const merged = mergeHistoryPage(current, page);
        void cache?.saveResource(accountKey, historyCacheKey(session.id), { items: merged, atSeq: page.atSeq }, page.nextCursor);
        return merged;
      });
      setHistoryAtSeq(page.atSeq);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  const header = (
    <View>
      <View style={styles.connectionBar}>
        <Text style={styles.connectionText}>{connectionStatusLabel(realtimeStatus)} · {statusText} · seq {state?.lastSeq ?? historyAtSeq}</Text>
        <Text style={styles.connectionSubtext}>AppState 会在回到前台时立即重连；断线期间不自动回答表单。</Text>
      </View>
      <NoticeBanner message={offline} />
      <NoticeBanner message={realtimeNotice} />
      <NoticeBanner message={error} tone="error" />
      {pendingSubmits.map((entry) => (
        <View key={entry.key} style={styles.formCard}>
          <Text style={styles.warningText}>{entry.phase === "prepared" ? "待发送（已保存）" : "提交确认中"} · {entry.command.kind} · {entry.key}</Text>
          <Text style={styles.codeText}>{JSON.stringify(entry.command.payload)}</Text>
          <ActionButton disabled={actionBusy} onPress={() => void submitCommand(entry.command, entry)} title="确认原提交（沿用原请求）" />
        </View>
      ))}
      {Object.entries(extensionUi.statuses).map(([key, value]) => <Text key={key} style={styles.infoText}>{key} · {value}</Text>)}
      {extensionUi.windowTitle ? <Text style={styles.infoText}>{extensionUi.windowTitle}</Text> : null}
      {extensionUi.header != null ? <View style={styles.formCard} testID="extension-header"><Text style={styles.codeText}>{extensionUi.header.join("\n")}</Text></View> : null}
      <ExtensionWorkingRow ui={extensionUi} active={state?.session.activeRunId != null} />
      <NoticeBanner message={extensionUi.unsupported} />
      {lastCommandId ? <Text style={styles.commandReceipt}>最近收据 · {lastCommandId}</Text> : null}
      <View style={styles.modelBar}>
        <View style={styles.modelBarText}>
          <Text style={styles.fieldLabel}>模型</Text>
          <Text style={styles.cardMeta}>{modelText}</Text>
        </View>
        <View style={styles.modelBarText}>
          <Text style={styles.fieldLabel}>思考等级</Text>
          <Text style={styles.cardMeta}>{state?.session.thinkingLevel ?? "未设置"}</Text>
        </View>
        <ActionButton kind="secondary" onPress={() => setShowModelForm((current) => !current)} title="配置" />
      </View>
      {showModelForm ? (
        <View style={styles.formCard}>
          <Text style={styles.cardTitle}>模型与思考等级</Text>
          <ActionButton kind="secondary" onPress={() => void loadCatalog(true)} title="刷新模型目录" />
          <Field autoCapitalize="none" label="Provider" onChangeText={setModelProvider} placeholder="例如 openai" value={modelProvider} />
          <Field autoCapitalize="none" label="模型 ID" onChangeText={setModelId} placeholder="例如 gpt-5" value={modelId} />
          <View style={styles.buttonRow}>
            <ActionButton
              disabled={actionBusy || modelProvider.trim().length === 0 || modelId.trim().length === 0 || !canRun("set_model")}
              onPress={() => void setModel({ provider: modelProvider.trim(), id: modelId.trim() })}
              title="切换模型"
            />
            <ActionButton kind="secondary" onPress={() => setPersistModel((current) => !current)} title={persistModel ? "保存为默认：是" : "保存为默认：否"} />
          </View>
          {models.length > 0 ? (
            <View style={styles.optionList}>
              <Text style={styles.fieldLabel}>服务器模型目录</Text>
              {models.map((model) => <ActionButton key={`${model.model.provider}/${model.model.id}`} disabled={actionBusy || !canRun("set_model")} kind="secondary" onPress={() => void setModel(model.model)} title={`${model.name} · ${model.model.provider}/${model.model.id}`} />)}
            </View>
          ) : null}
          <Text style={styles.fieldLabel}>可用思考等级</Text>
          <View style={styles.chipRow}>
            {currentThinkingLevels.length > 0 ? currentThinkingLevels.map((level) => (
              <ActionButton disabled={actionBusy || !canRun("set_thinking")} key={level} kind={state?.session.thinkingLevel === level ? "primary" : "secondary"} onPress={() => void setThinking(level)} title={level} />
            )) : <Text style={styles.muted}>服务器尚未返回 thinking 等级；不臆造可用值。</Text>}
          </View>
          {capabilities?.nativeCapabilities.some((capability) => capability.status === "needs_adapter") ? <Text style={styles.warningText}>部分终端专属 UI 尚无手机组件；需要扩展提供文本或标准表单回退。</Text> : null}
        </View>
      ) : null}
      {showMenu ? (
        <View style={styles.menuCard}>
          <View style={styles.buttonRow}>
            <ActionButton disabled={actionBusy || !canRun("compact")} onPress={() => void submitCommand({ kind: "compact", payload: { expectedVersion: state?.session.version ?? 0 } })} title="压缩上下文" />
            <ActionButton kind="secondary" onPress={() => setShowNewSession((current) => !current)} title="新建 Session" />
            <ActionButton kind="secondary" onPress={() => { setShowRename((current) => !current); setShowNewSession(false); }} title="改名" />
            <ActionButton disabled={actionBusy} kind={state?.session.archivedAt ? "secondary" : "danger"} onPress={() => void toggleArchive()} title={state?.session.archivedAt ? "恢复" : "归档"} />
          </View>
          {showNewSession ? (
            <View style={styles.formCard}>
              <Field label="新 Session 标题（可选）" onChangeText={setNewSessionTitle} placeholder="新会话" value={newSessionTitle} />
              <ActionButton disabled={actionBusy} onPress={() => void createSession()} title="创建并打开" />
            </View>
          ) : null}
          {showRename ? (
            <View style={styles.formCard}>
              <Field label="Session 标题" onChangeText={setRenameValue} placeholder="Session 标题" value={renameValue} />
              <ActionButton disabled={actionBusy} onPress={() => void renameSession()} title="保存标题" />
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={styles.buttonRow}>
        <ActionButton kind="secondary" onPress={() => setShowMenu((current) => !current)} title={showMenu ? "收起菜单" : "操作菜单"} />
        <ActionButton disabled={actionBusy} kind="secondary" onPress={() => void refresh()} title="刷新快照" />
      </View>
      {pauseLabel ? (
        <View style={styles.queueCard}>
          <Text style={styles.warningText}>{pauseLabel}</Text>
          <View style={styles.buttonRow}>
            <ActionButton
              disabled={actionBusy || !canRun("resume_queue")}
              onPress={() => void submitCommand({ kind: "resume_queue", payload: { expectedQueueVersion: state?.queue.version ?? 0, afterRunId: state?.queue.pause?.runId ?? "" } })}
              title="恢复旧队列"
            />
            <Text style={styles.toolMeta}>队列版本 {state?.queue.version}</Text>
          </View>
        </View>
      ) : null}
      {state && state.queue.items.length > 0 ? (
        <View style={styles.queueCard}>
          <Text style={styles.cardTitle}>后续队列 · {state.queue.items.length}</Text>
          {state.queue.items.map((item) => (
            <View key={item.commandId} style={styles.queueItem}>
              <Text style={styles.toolMeta}>{item.position + 1}. {item.kind} · {item.commandId}</Text>
              <ActionButton disabled={actionBusy || !canRun("cancel_queued")} kind="quiet" onPress={() => void submitCommand({ kind: "cancel_queued", payload: { targetCommandId: item.commandId } })} title="取消" />
            </View>
          ))}
        </View>
      ) : null}
      {drafts.length > 0 ? (
        <View style={styles.queueCard}>
          <Text style={styles.cardTitle}>可恢复输入草稿</Text>
          {drafts.map((draft) => (
            <View key={draft.inputId} style={styles.draftCard}>
              <Text style={styles.toolMeta}>{draft.state === "unknown" ? "结果未知" : "已返回"} · {draft.delivery} · {draft.inputId}</Text>
              <Text numberOfLines={4} style={styles.preview}>{draft.content.text || "（空输入，可能包含附件）"}</Text>
              {draft.content.attachments?.length ? <Text style={styles.toolMeta}>附件 {draft.content.attachments.length} 个；重新发送会创建新的命令。</Text> : null}
              <ActionButton kind="secondary" onPress={() => {
                setComposerMode("prompt");
                setSendMode(draft.delivery === "steer" ? "steer" : "follow_up");
                setComposerText(draft.content.text);
                setAttachments(draft.content.attachments ?? []);
                setAttachmentNames((draft.content.attachments ?? []).map(() => "已恢复附件"));
                setAttachmentArtifactId("");
              }} title="填入输入框" />
            </View>
          ))}
        </View>
      ) : null}
      {interactions.map((interaction) => (
        <InteractionCard
          customLines={extensionUi.customFrames[interaction.operationId]}
          busy={actionBusy || respondingId === interaction.interactionId}
          interaction={interaction}
          key={interaction.interactionId}
          onRespond={respondToInteraction}
        />
      ))}
      <ExtensionWidgets ui={extensionUi} placement="aboveEditor" />
      <View style={styles.composerCard}>
        <View style={styles.chipRow}>
          <ActionButton kind={composerMode === "prompt" ? "primary" : "secondary"} onPress={() => setComposerMode("prompt")} title="输入" />
          <ActionButton disabled={!canRun("bash")} kind={composerMode === "bash" ? "primary" : "secondary"} onPress={() => setComposerMode("bash")} title="用户 Bash" />
          <ActionButton disabled={!canRun("extension_command")} kind={composerMode === "extension" ? "primary" : "secondary"} onPress={() => setComposerMode("extension")} title="/ 扩展命令" />
        </View>
        {composerMode === "prompt" && activeId ? (
          <View style={styles.chipRow}>
            <ActionButton kind={sendMode === "steer" ? "primary" : "secondary"} onPress={() => setSendMode("steer")} title="Steer 当前 Run" />
            <ActionButton kind={sendMode === "follow_up" ? "primary" : "secondary"} onPress={() => setSendMode("follow_up")} title="Follow-up 入队" />
          </View>
        ) : null}
        {composerMode === "bash" ? <Text style={styles.warningText}>原生 Bash 入口不增加逐条审批或默认超时；停止范围只针对用户 Bash。</Text> : null}
        {composerMode === "extension" ? <Text style={styles.infoText}>扩展 slash 命令通过 extension_command 即时发送，不伪装成普通模型文本。</Text> : null}
        <TextInput
          editable={!actionBusy}
          multiline
          onChangeText={updateEditor}
          placeholder={composerMode === "bash" ? "输入 shell 命令" : composerMode === "extension" ? "/command args" : "继续这个 Session…"}
          placeholderTextColor={colors.placeholder}
          style={styles.composerInput}
          onSelectionChange={(event) => { extensionUiRef.current = { ...extensionUiRef.current, editorSelection: event.nativeEvent.selection }; }}
          testID="session-composer"
          value={composerText}
        />
        {composerMode === "prompt" ? (
          <View style={styles.attachmentCard}>
            <Text style={styles.toolMeta}>附件（可选）：从系统文件选择器选择图片，上传成功后才会附加到 Prompt。文件内容只发送到当前 Session 的服务器。</Text>
            <ActionButton disabled={actionBusy} kind="secondary" onPress={() => void pickAttachments()} testID="attachment-pick" title="选择图片并上传" />
            {attachments.map((attachment, index) => (
              <View key={`${attachment.artifactId}-${index}`} style={styles.attachmentRow}>
                <Text numberOfLines={1} style={styles.toolMeta}>{attachmentNames[index] ?? "附件"} · {attachment.mimeType}</Text>
                <ActionButton kind="quiet" onPress={() => {
                  setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
                  setAttachmentNames((current) => current.filter((_, currentIndex) => currentIndex !== index));
                }} title="移除" />
              </View>
            ))}
            <Field autoCapitalize="none" label="已有 artifact ID（可选）" onChangeText={setAttachmentArtifactId} placeholder="粘贴服务器已有附件 ID" value={attachmentArtifactId} />
            {attachmentArtifactId.trim().length > 0 ? <Field autoCapitalize="none" label="MIME 类型" onChangeText={setAttachmentMimeType} placeholder="image/png" value={attachmentMimeType} /> : null}
          </View>
        ) : null}
        {composerMode === "bash" ? <ActionButton kind="secondary" onPress={() => setBashExcludeFromContext((current) => !current)} title={bashExcludeFromContext ? "!!：不写入上下文" : "!：写入上下文"} /> : null}
        <View style={styles.buttonRow}>
          {pendingSubmits.length > 0 ? <ActionButton disabled={actionBusy} kind={explicitNew ? "primary" : "secondary"} onPress={() => setExplicitNew((current) => !current)} title={explicitNew ? "当前输入将作为新提交" : "将当前输入作为明确的新提交"} /> : null}
          <ActionButton disabled={actionBusy || composerText.trim().length === 0 || !canRun(composerMode === "prompt" ? sendMode === "follow_up" ? "follow_up" : "prompt" : composerMode === "bash" ? "bash" : "extension_command")} onPress={() => void sendComposer()} title={composerMode === "bash" ? "执行 Bash" : composerMode === "extension" ? "执行扩展" : sendMode === "follow_up" ? "加入 Follow-up" : sendMode === "steer" && activeId ? "发送 Steer" : "发送 Prompt"} />
          {activeId && canRun("abort") ? <ActionButton disabled={actionBusy} kind="danger" onPress={() => void submitCommand({ kind: "abort", payload: { targetRunId: activeId } })} title="停止模型 Run" /> : null}
          {bashActive && canRun("abort_bash") ? <ActionButton disabled={actionBusy} kind="danger" onPress={() => void submitCommand({ kind: "abort_bash", payload: {} })} title="停止用户 Bash" /> : null}
        </View>
      </View>
      <ExtensionWidgets ui={extensionUi} placement="belowEditor" />
      {extensionUi.footer != null ? <View style={styles.formCard} testID="extension-footer"><Text style={styles.codeText}>{extensionUi.footer.join("\n")}</Text></View> : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.flex}>
      <View style={styles.page}>
        <PageHeader onBack={onBack} right={<ActionButton kind="quiet" onPress={() => setShowMenu((current) => !current)} title="菜单" />} title={state?.session.title ?? session.title} subtitle="执行时间线与实时控制" />
        {loading && items.length === 0 ? <LoadingScreen message="正在读取快照与历史" /> : null}
        <FlatList
          contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
          data={items}
          keyExtractor={(item) => item.itemId}
          ListEmptyComponent={<Text style={styles.emptyText}>这个 Session 还没有可显示的时间线。</Text>}
          ListFooterComponent={nextCursor ? <ActionButton disabled={loadingMore} kind="secondary" onPress={() => void loadMore()} title={loadingMore ? "加载中…" : "加载更早记录"} /> : null}
          ListHeaderComponent={header}
          extraData={extensionUi}
          renderItem={({ item }) => <ExecutionTimelineRow item={item} ui={extensionUi} />}
        />
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const [credentialStore] = useState<SecureCredentialsStore>(() => createSecureCredentialsStore());
  const [cache, setCache] = useState<MobileCache | null>(null);
  const [credentials, setCredentials] = useState<DeviceCredentials | null>(null);
  const [screen, setScreen] = useState<Screen>("projects");
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [booting, setBooting] = useState(true);
  const [pairingMessage, setPairingMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const cachePromise = openMobileCache().then((opened) => {
        if (active) setCache(opened);
      }).catch(() => undefined);
      const stored = await credentialStore.load().catch(() => null);
      await cachePromise;
      if (!active) return;
      if (stored === null) {
        setBooting(false);
        return;
      }
      try {
        const api = new PiRemoteApi(stored);
        const me = await api.getMe();
        if (!active) return;
        setCredentials({ ...stored, user: me.user });
      } catch (caught) {
        if (isCredentialError(caught)) {
          await credentialStore.clear().catch(() => undefined);
          if (active) setPairingMessage("设备凭据已失效，请重新输入一次性配对令牌。");
        } else if (active) {
          // A network error does not invalidate credentials. Cached projects
          // remain readable and the next refresh will retry the server.
          setCredentials(stored);
          setPairingMessage("当前离线，连接恢复后会自动尝试刷新。");
        }
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => { active = false; };
  }, [credentialStore]);

  const api = useMemo(() => credentials ? new PiRemoteApi(credentials) : null, [credentials]);
  const accountKey = credentials ? accountCacheKey(credentials) : null;

  const handlePaired = async (next: DeviceCredentials) => {
    await credentialStore.save(next);
    setCredentials(next);
    setPairingMessage(null);
    setScreen("projects");
  };

  const signOut = async () => {
    const oldAccountKey = accountKey;
    await credentialStore.clear();
    if (oldAccountKey) await cache?.deleteAccount(oldAccountKey);
    setCredentials(null);
    setSelectedProject(null);
    setSelectedSession(null);
    setScreen("projects");
  };

  if (booting) return <LoadingScreen />;
  if (!credentials || !api || !accountKey) return <PairingScreen initialMessage={pairingMessage} onPaired={handlePaired} />;
  if (screen === "sessions" && selectedProject) {
    return (
      <SessionsScreen
        accountKey={accountKey}
        api={api}
        cache={cache}
        onBack={() => { setScreen("projects"); setSelectedProject(null); }}
        onOpenSession={(session) => { setSelectedSession(session); setScreen("history"); }}
        project={selectedProject}
      />
    );
  }
  if (screen === "history" && selectedSession) {
    return (
      <ExecutionScreen
        key={`${accountKey}:${selectedSession.id}`}
        accountKey={accountKey}
        api={api}
        cache={cache}
        onBack={() => { setScreen("sessions"); setSelectedSession(null); }}
        onCreatedSession={(created) => { setSelectedSession(created); setScreen("history"); }}
        session={selectedSession}
      />
    );
  }
  return (
    <ProjectsScreen
      accountKey={accountKey}
      api={api}
      cache={cache}
      onOpenProject={(project) => { setSelectedProject(project); setScreen("sessions"); }}
      onSignOut={signOut}
    />
  );
}

const colors = {
  accent: "#2563eb",
  background: "#f5f7fb",
  border: "#dbe3ef",
  danger: "#b42318",
  muted: "#64748b",
  placeholder: "#94a3b8",
  text: "#172033",
  white: "#ffffff"
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { alignItems: "center", backgroundColor: colors.background, flex: 1, gap: 12, justifyContent: "center", padding: 24 },
  muted: { color: colors.muted, fontSize: 14 },
  pairingPage: { backgroundColor: colors.background, flexGrow: 1, justifyContent: "center", padding: 24 },
  brandMark: { alignItems: "center", alignSelf: "flex-start", backgroundColor: colors.accent, borderRadius: 18, height: 56, justifyContent: "center", marginBottom: 20, width: 56 },
  brandMarkText: { color: colors.white, fontSize: 34, fontWeight: "800" },
  heroTitle: { color: colors.text, fontSize: 32, fontWeight: "800", marginBottom: 8 },
  heroSubtitle: { color: colors.muted, fontSize: 16, lineHeight: 24, marginBottom: 24, maxWidth: 520 },
  securityNote: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 18 },
  page: { backgroundColor: colors.background, flex: 1, paddingHorizontal: 16 },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", minHeight: 78, paddingVertical: 12 },
  headerMain: { alignItems: "center", flex: 1, flexDirection: "row", gap: 6 },
  headerTitleWrap: { flexShrink: 1 },
  headerTitle: { color: colors.text, fontSize: 24, fontWeight: "800" },
  headerSubtitle: { color: colors.muted, fontSize: 13, marginTop: 3 },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "700", marginBottom: 6 },
  input: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.text, fontSize: 16, minHeight: 48, paddingHorizontal: 14 },
  inlineInput: { backgroundColor: colors.white, borderColor: colors.accent, borderRadius: 8, borderWidth: 1, color: colors.text, fontSize: 18, minHeight: 42, paddingHorizontal: 10 },
  button: { alignItems: "center", backgroundColor: colors.accent, borderRadius: 9, justifyContent: "center", minHeight: 42, paddingHorizontal: 16 },
  buttonText: { color: colors.white, fontSize: 14, fontWeight: "700" },
  secondaryButton: { backgroundColor: colors.white, borderColor: colors.border, borderWidth: 1 },
  secondaryButtonText: { color: colors.text },
  dangerButton: { backgroundColor: colors.danger },
  quietButton: { backgroundColor: "transparent", minHeight: 34, paddingHorizontal: 8 },
  quietButtonText: { color: colors.accent },
  disabledButton: { opacity: 0.5 },
  pressedButton: { opacity: 0.8 },
  banner: { borderRadius: 9, marginBottom: 12, padding: 12 },
  infoBanner: { backgroundColor: "#e8f1ff" },
  errorBanner: { backgroundColor: "#fff0ee" },
  infoText: { color: "#1d4ed8", fontSize: 13, lineHeight: 18 },
  errorText: { color: colors.danger, fontSize: 13, lineHeight: 18 },
  formCard: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginBottom: 12, padding: 14 },
  card: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginBottom: 12, padding: 14 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginBottom: 5 },
  cardMeta: { color: colors.muted, fontSize: 13, marginBottom: 8 },
  preview: { color: colors.text, fontSize: 14, lineHeight: 20, marginBottom: 10 },
  warningText: { color: "#9a6700", fontSize: 12, lineHeight: 17, marginBottom: 6 },
  buttonRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  list: { paddingBottom: 24, paddingTop: 10 },
  emptyList: { flexGrow: 1, justifyContent: "center", padding: 24 },
  emptyText: { color: colors.muted, fontSize: 15, lineHeight: 23, textAlign: "center" },
  segmented: { backgroundColor: "#e7edf6", borderRadius: 10, flexDirection: "row", marginBottom: 12, padding: 3 },
  segment: { alignItems: "center", borderRadius: 8, flex: 1, minHeight: 38, justifyContent: "center" },
  segmentActive: { backgroundColor: colors.white },
  segmentText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  segmentTextActive: { color: colors.text, fontSize: 13, fontWeight: "800" },
  timelineCard: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginBottom: 10, padding: 14 },
  timelineHeadingRow: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between", gap: 10 },
  timelineTitle: { color: colors.text, fontSize: 13, fontWeight: "800", marginBottom: 8 },
  timelineText: { color: colors.text, fontSize: 15, lineHeight: 23, marginBottom: 6 },
  thinkingText: { color: "#7457a6", fontSize: 14, fontStyle: "italic", lineHeight: 21, marginBottom: 6 },
  codeText: { backgroundColor: "#f1f5f9", color: "#334155", fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 12, lineHeight: 18, marginBottom: 6, padding: 8 },
  toolMeta: { color: colors.muted, fontSize: 12, lineHeight: 17, marginBottom: 7 },
  liveBadge: { color: colors.accent, fontSize: 12, fontWeight: "800", marginBottom: 6 },
  toolCallBlock: { marginBottom: 2 },
  connectionBar: { backgroundColor: "#eaf7f1", borderRadius: 10, marginBottom: 10, padding: 12 },
  connectionText: { color: "#146c43", fontSize: 13, fontWeight: "800", lineHeight: 18 },
  connectionSubtext: { color: "#287653", fontSize: 12, lineHeight: 17, marginTop: 3 },
  commandReceipt: { color: colors.muted, fontSize: 11, marginBottom: 8 },
  modelBar: { alignItems: "center", backgroundColor: colors.white, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 10, marginBottom: 10, padding: 12 },
  modelBarText: { flex: 1, minWidth: 0 },
  menuCard: { backgroundColor: "#eef4ff", borderColor: "#cbdcfb", borderRadius: 12, borderWidth: 1, marginBottom: 10, padding: 10 },
  queueCard: { backgroundColor: "#fffaf0", borderColor: "#f1d58b", borderRadius: 12, borderWidth: 1, marginBottom: 10, padding: 12 },
  queueItem: { alignItems: "center", borderTopColor: "#f1d58b", borderTopWidth: 1, flexDirection: "row", justifyContent: "space-between", paddingVertical: 7 },
  draftCard: { borderTopColor: "#f1d58b", borderTopWidth: 1, marginTop: 5, paddingTop: 8 },
  interactionCard: { backgroundColor: "#f8f5ff", borderColor: "#d9c8ff", borderRadius: 12, borderWidth: 1, marginBottom: 10, padding: 14 },
  optionList: { gap: 8, marginVertical: 4 },
  chipRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  composerCard: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginBottom: 14, padding: 14 },
  composerInput: { backgroundColor: "#f8fafc", borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.text, fontSize: 16, lineHeight: 23, minHeight: 92, padding: 12, textAlignVertical: "top" },
  editorInput: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.text, fontSize: 16, lineHeight: 23, minHeight: 120, padding: 12, textAlignVertical: "top" },
  attachmentCard: { backgroundColor: "#f8fafc", borderRadius: 9, marginTop: 10, padding: 10 },
  attachmentRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginTop: 6 }
});
