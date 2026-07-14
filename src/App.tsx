/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Brain, 
  Cpu, 
  Layers, 
  Settings, 
  Terminal, 
  Search, 
  Sparkles, 
  CheckCircle, 
  XCircle, 
  AlertCircle, 
  Clock, 
  ExternalLink, 
  Copy, 
  Save, 
  Play, 
  RefreshCw, 
  FileText, 
  Filter, 
  Shield, 
  Trash2,
  Lock,
  User,
  Eye,
  EyeOff,
  Zap,
  MessageSquare
} from 'lucide-react';
import { Project, ProjectStatus, SystemLog, SystemConfig } from './types';

export default function App() {
  // State definitions
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState({ total: 0, seen: 0, generating: 0, pending: 0, sent: 0, failed: 0 });
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [logs, setLogs] = useState<SystemLog[]>([]);
  
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [editedProposal, setEditedProposal] = useState<string>('');
  const [editedPrice, setEditedPrice] = useState<number>(0);
  const [editedTime, setEditedTime] = useState<number>(0);
  
  // UI States
  const [isScraping, setIsScraping] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRunningWorker, setIsRunningWorker] = useState(false);
  const [isRunningAutopilot, setIsRunningAutopilot] = useState(false);
  const [isTogglingAutoMode, setIsTogglingAutoMode] = useState(false);
  const [isTogglingChatReply, setIsTogglingChatReply] = useState(false);
  const [chatReplyStatus, setChatReplyStatus] = useState({
    enabled: false,
    running: false,
    repliedCount: 0
  });
  const [autoModeStatus, setAutoModeStatus] = useState({
    enabled: false,
    pipelineRunning: false,
    generating: false,
    submitting: false,
    scraping: false,
    spacingSeconds: { generate: '2-6', submit: '45-90' },
    backlog: { seen: 0, generating: 0, pending: 0 }
  });
  const [isOpeningLogin, setIsOpeningLogin] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [keywordFilter, setKeywordFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [newBlacklistKeyword, setNewBlacklistKeyword] = useState('');
  const [newWhitelistKeyword, setNewWhitelistKeyword] = useState('');
  
  // Selection
  const selectedProject = projects.find(p => p.id === selectedProjectId);

  // Load configuration, logs and projects initially
  useEffect(() => {
    fetchConfig();
    fetchProjects();
    fetchLogs();
    
    // Poll API for updates without triggering full page reloads
    const interval = setInterval(() => {
      silentPoll();
      fetchAutoModeStatus();
      fetchChatReplyStatus();
    }, 8000);
    
    fetchAutoModeStatus();
    fetchChatReplyStatus();
    return () => clearInterval(interval);
  }, []);

  const fetchAutoModeStatus = async () => {
    try {
      const res = await fetch('/api/auto-mode/status');
      if (res.ok) {
        const data = await res.json();
        setAutoModeStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch auto mode status', e);
    }
  };

  const fetchChatReplyStatus = async () => {
    try {
      const res = await fetch('/api/chat-reply/status');
      if (res.ok) {
        const data = await res.json();
        setChatReplyStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch chat reply status', e);
    }
  };

  // Whenever selected project changes, dump its proposal variables inside textfields
  useEffect(() => {
    if (selectedProject) {
      setEditedProposal(selectedProject.generatedProposal || '');
      setEditedPrice(selectedProject.suggestedPrice || 0);
      setEditedTime(selectedProject.suggestedTime || 0);
    }
  }, [selectedProjectId, selectedProject]);

  const silentPoll = async () => {
    try {
      const projRes = await fetch('/api/projects');
      if (projRes.ok) {
        const data = await projRes.json();
        setProjects(prev => JSON.stringify(prev) === JSON.stringify(data.projects) ? prev : data.projects);
        setStats(prev => JSON.stringify(prev) === JSON.stringify(data.stats) ? prev : data.stats);
      }

      const logRes = await fetch('/api/logs');
      if (logRes.ok) {
        const data = await logRes.json();
        setLogs(prev => JSON.stringify(prev) === JSON.stringify(data) ? prev : data);
      }
    } catch (e) {
      console.error('Failed to silent poll', e);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      }
    } catch (e) {
      console.error('Failed to fetch config', e);
    }
  };

  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects);
        setStats(data.stats);
        if (data.projects.length > 0 && !selectedProjectId) {
          setSelectedProjectId(data.projects[0].id);
        }
      }
    } catch (e) {
      console.error('Failed to fetch projects', e);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (e) {
      console.error('Failed to fetch logs', e);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    setIsSavingConfig(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        fetchLogs();
      }
    } catch (e) {
      console.error('Failed to save config', e);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleScrape = async () => {
    setIsScraping(true);
    try {
      const res = await fetch('/api/scrape', { method: 'POST' });
      if (res.ok) {
        await fetchProjects();
        await fetchLogs();
      }
    } catch (e) {
      console.error('Scraping error', e);
    } finally {
      setIsScraping(false);
    }
  };

  const handleGenerateProposal = async () => {
    if (!selectedProjectId) return;
    setIsGenerating(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProjectId }),
      });
      if (res.ok) {
        await fetchProjects();
        await fetchLogs();
      } else {
        const err = await res.json();
        alert(`Erro de geração: ${err.error || 'Erro temporário do servidor'}`);
      }
    } catch (e) {
      console.error('AI generation error', e);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveProposalOverride = async () => {
    if (!selectedProjectId) return;
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generatedProposal: editedProposal,
          suggestedPrice: editedPrice,
          suggestedTime: editedTime,
          status: ProjectStatus.PENDING_REVIEW // Keep/set in queue review
        }),
      });
      if (res.ok) {
        await fetchProjects();
        await fetchLogs();
        alert('Modificações de proposta salvas no banco com sucesso!');
      }
    } catch (e) {
      console.error('Failed to save manual override', e);
    }
  };

  const handleSubmitProposalManualOverride = async (status: ProjectStatus) => {
    if (!selectedProjectId) return;
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          generatedProposal: editedProposal,
          suggestedPrice: editedPrice,
          suggestedTime: editedTime
        }),
      });
      if (res.ok) {
        await fetchProjects();
        await fetchLogs();
      }
    } catch (e) {
      console.error('Failed status dispatch', e);
    }
  };

  const handleTriggerWorker = async () => {
    setIsRunningWorker(true);
    try {
      const res = await fetch('/api/worker/run', { method: 'POST' });
      if (res.ok) {
        await fetchProjects();
        await fetchLogs();
      }
    } catch (e) {
      console.error('Failed to trigger worker', e);
    } finally {
      setIsRunningWorker(false);
    }
  };

  const handleOpenLoginBrowser = async () => {
    setIsOpeningLogin(true);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        await fetchConfig();
        await fetchLogs();
        alert(data.message || 'Login salvo no perfil persistente.');
      } else {
        alert(data.message || 'Não foi possível concluir o login.');
      }
    } catch (e) {
      console.error('Failed to open login browser', e);
      alert('Erro ao abrir browser de login.');
    } finally {
      setIsOpeningLogin(false);
    }
  };

  const handleToggleAutoMode = async () => {
    setIsTogglingAutoMode(true);
    try {
      const res = await fetch('/api/auto-mode/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autoModeStatus.enabled })
      });
      if (res.ok) {
        const data = await res.json();
        setConfig((prev) => (prev ? { ...prev, autoSubmit: data.enabled } : prev));
        await fetchAutoModeStatus();
        await fetchLogs();
      }
    } catch (e) {
      console.error('Failed to toggle auto mode', e);
    } finally {
      setIsTogglingAutoMode(false);
    }
  };

  const handleToggleChatReply = async () => {
    setIsTogglingChatReply(true);
    try {
      const res = await fetch('/api/chat-reply/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !chatReplyStatus.enabled })
      });
      if (res.ok) {
        const data = await res.json();
        setConfig((prev) => (prev ? { ...prev, autoReplyMessages: data.enabled } : prev));
        await fetchChatReplyStatus();
        await fetchLogs();
      }
    } catch (e) {
      console.error('Failed to toggle chat reply', e);
    } finally {
      setIsTogglingChatReply(false);
    }
  };

  const handleRunChatReply = async () => {
    try {
      const res = await fetch('/api/chat-reply/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Não foi possível iniciar a leitura do chat.');
        return;
      }
      await fetchLogs();
      await fetchChatReplyStatus();
    } catch (e) {
      console.error('Failed to run chat reply', e);
    }
  };

  const handleRunAutopilot = async () => {
    if (!confirm('Disparar autopilot nas 10 primeiras oportunidades "vistas"?\n\nGera propostas com IA, coloca na fila e envia com pausas anti-detecção (~45-90s entre envios).')) {
      return;
    }

    setIsRunningAutopilot(true);
    try {
      const res = await fetch('/api/autopilot/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchSize: 10 })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Autopilot não pôde iniciar.');
        setIsRunningAutopilot(false);
        return;
      }

      const poll = setInterval(async () => {
        await fetchProjects();
        await fetchLogs();
        const statusRes = await fetch('/api/autopilot/status');
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (!status.running) {
            clearInterval(poll);
            setIsRunningAutopilot(false);
            await fetchProjects();
            await fetchLogs();
          }
        }
      }, 5000);
    } catch (e) {
      console.error('Autopilot error', e);
      setIsRunningAutopilot(false);
    }
  };

  const handleResetDB = async () => {
    if (confirm('Aviso: Isso irá redefinir todos os trabalhos crawling e cadastros limpos. Confirmar limpeza?')) {
      try {
        const res = await fetch('/api/projects/reset', { method: 'POST' });
        if (res.ok) {
          setSelectedProjectId(null);
          await fetchProjects();
          await fetchLogs();
        }
      } catch (e) {
        console.error('Reset DB error', e);
      }
    }
  };

  const handleDeleteProject = async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        if (selectedProjectId === id) {
          setSelectedProjectId(null);
        }
        await fetchProjects();
        await fetchLogs();
      }
    } catch (e) {
      console.error('Delete project error', e);
    }
  };

  // Keywords management
  const addBlacklistKeyword = () => {
    if (!config || !newBlacklistKeyword.trim()) return;
    if (config.blacklistKeywords.includes(newBlacklistKeyword.trim())) return;
    const updated = [...config.blacklistKeywords, newBlacklistKeyword.trim()];
    setConfig({ ...config, blacklistKeywords: updated });
    setNewBlacklistKeyword('');
  };

  const removeBlacklistKeyword = (kw: string) => {
    if (!config) return;
    const updated = config.blacklistKeywords.filter(k => k !== kw);
    setConfig({ ...config, blacklistKeywords: updated });
  };

  const addWhitelistKeyword = () => {
    if (!config || !newWhitelistKeyword.trim()) return;
    if (config.whitelistKeywords.includes(newWhitelistKeyword.trim())) return;
    const updated = [...config.whitelistKeywords, newWhitelistKeyword.trim()];
    setConfig({ ...config, whitelistKeywords: updated });
    setNewWhitelistKeyword('');
  };

  const removeWhitelistKeyword = (kw: string) => {
    if (!config) return;
    const updated = config.whitelistKeywords.filter(k => k !== kw);
    setConfig({ ...config, whitelistKeywords: updated });
  };

  const copyToClipboard = () => {
    if (!editedProposal) return;
    navigator.clipboard.writeText(editedProposal);
    alert('Termo de Proposta copiado para a área de transferência!');
  };

  // Filtering projects list
  const filteredProjects = projects.filter(p => {
    const hitsQuery = p.title.toLowerCase().includes(keywordFilter.toLowerCase()) || 
                      p.description.toLowerCase().includes(keywordFilter.toLowerCase()) ||
                      p.skills.some(s => s.toLowerCase().includes(keywordFilter.toLowerCase()));
    
    if (statusFilter === 'all') return hitsQuery;
    return hitsQuery && p.status === statusFilter;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950">
      
      {/* HEADERBAR ROW */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 z-40 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-tr from-cyan-500 to-indigo-600 rounded-xl shadow-lg ring-1 ring-cyan-400/20">
            <Cpu className="w-6 h-6 text-slate-950 animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
              Workana Sniper Automation
            </h1>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
              <span className={`w-2 h-2 rounded-full inline-block ${autoModeStatus.enabled ? 'bg-emerald-500 animate-ping' : 'bg-slate-600'}`}></span>
              {autoModeStatus.enabled
                ? autoModeStatus.submitting
                  ? 'Modo automático — enviando propostas...'
                  : autoModeStatus.generating
                    ? 'Modo automático — gerando com IA...'
                    : autoModeStatus.scraping
                      ? 'Modo automático — varrendo Workana...'
                      : 'Modo automático ATIVO — scrape + IA + envio'
                : 'Modo manual — ative o Sniper Automático no topo'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto flex-wrap justify-end">
          <button
            type="button"
            onClick={handleToggleAutoMode}
            disabled={isTogglingAutoMode}
            className={`flex-1 md:flex-none py-2.5 px-4 rounded-xl font-black text-xs flex items-center justify-center gap-2 shadow-lg transition-all ${
              autoModeStatus.enabled
                ? 'bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 ring-2 ring-emerald-400/40 animate-pulse'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
            }`}
          >
            {isTogglingAutoMode ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className={`w-4 h-4 ${autoModeStatus.enabled ? 'fill-current' : ''}`} />
            )}
            {autoModeStatus.enabled ? 'Sniper Automático ON' : 'Sniper Automático'}
          </button>
          <button
            type="button"
            onClick={handleToggleChatReply}
            disabled={isTogglingChatReply}
            className={`flex-1 md:flex-none py-2.5 px-4 rounded-xl font-black text-xs flex items-center justify-center gap-2 shadow-lg transition-all ${
              chatReplyStatus.enabled
                ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-slate-950 ring-2 ring-amber-400/40'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
            }`}
          >
            {isTogglingChatReply ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <MessageSquare className={`w-4 h-4 ${chatReplyStatus.enabled ? 'fill-current' : ''}`} />
            )}
            {chatReplyStatus.enabled
              ? chatReplyStatus.running
                ? 'Chat respondendo...'
                : 'Chat Auto ON'
              : 'Chat Auto'}
          </button>
        </div>

        {/* TOP STATUS COUNTERS */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 md:gap-4 w-full md:w-auto">
          <div className="bg-slate-900/80 rounded-lg p-2 border border-slate-800/80 text-center">
            <div className="text-xs text-slate-400">Varridos</div>
            <div className="text-base font-bold text-slate-100">{stats.total}</div>
          </div>
          <div className="bg-slate-900/80 rounded-lg p-2 border border-slate-800/80 text-center">
            <div className="text-xs text-slate-400">Novos</div>
            <div className="text-base font-bold text-sky-400">{stats.seen}</div>
          </div>
          <div className="bg-slate-950 rounded-lg p-2 border border-indigo-900/30 text-center">
            <div className="text-xs text-slate-400">Gerando</div>
            <div className="text-base font-bold text-indigo-400 animate-pulse">{stats.generating}</div>
          </div>
          <div className="bg-slate-900/80 rounded-lg p-2 border border-slate-800/80 text-center">
            <div className="text-xs text-slate-400">No Gatilho</div>
            <div className="text-base font-bold text-amber-400">{stats.pending}</div>
          </div>
          <div className="bg-slate-900/80 rounded-lg p-2 border border-emerald-950 text-center">
            <div className="text-xs text-slate-400">Enviados</div>
            <div className="text-base font-bold text-emerald-400">{stats.sent}</div>
          </div>
          <div className="bg-slate-900/80 rounded-lg p-2 border border-rose-950 text-center">
            <div className="text-xs text-slate-400">Falhas</div>
            <div className="text-base font-bold text-rose-400">{stats.failed}</div>
          </div>
        </div>
      </header>

      {/* THREE-COLUMN BENTO CORE LAYOUT */}
      <main className="flex-1 overflow-hidden grid grid-cols-1 xl:grid-cols-12 gap-5 p-5 min-h-[500px]">
        
        {/* PANEL 1: CONFIGURATION (xl:col-span-3) */}
        <section className="xl:col-span-3 bg-slate-900/40 border border-slate-800 rounded-xl p-5 flex flex-col overflow-y-auto gap-4" id="config-panel">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="font-semibold text-sm tracking-wider uppercase text-slate-300 flex items-center gap-2">
              <Settings className="w-4 h-4 text-cyan-400" />
              Painel de Parâmetros
            </h2>
            <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full font-mono">
              Configurador
            </span>
          </div>

          {config ? (
            <form onSubmit={handleSaveConfig} className="flex flex-col gap-4">
              
              {/* Toggle Mode Mode */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-slate-200 block">Modo Automático Completo</label>
                    <span className="text-[10px] text-slate-400">Varre, gera com IA e envia propostas sozinho</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleAutoMode}
                    disabled={isTogglingAutoMode}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${config.autoSubmit ? 'bg-cyan-500' : 'bg-slate-700'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${config.autoSubmit ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
                <div className="mt-2 text-center">
                  <span className={`text-[10px] px-2 py-0.5 font-bold rounded ${config.autoSubmit ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-blue-950 text-blue-400 border border-blue-900'}`}>
                    {config.autoSubmit ? 'SCRAPE + IA + ENVIO AUTOMÁTICOS' : 'MODO MANUAL (APENAS MODELAGEM IA)'}
                  </span>
                </div>
              </div>

              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-slate-200 block">Auto-resposta no Chat</label>
                    <span className="text-[10px] text-slate-400">Lê inbox e responde msgs curtas/informais</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleChatReply}
                    disabled={isTogglingChatReply}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${config.autoReplyMessages ? 'bg-amber-500' : 'bg-slate-700'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${config.autoReplyMessages ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className={`text-[10px] px-2 py-0.5 font-bold rounded ${config.autoReplyMessages ? 'bg-amber-950 text-amber-300 border border-amber-900' : 'bg-slate-900 text-slate-400 border border-slate-700'}`}>
                    {config.autoReplyMessages
                      ? `CHAT ON · ${chatReplyStatus.repliedCount} resp.`
                      : 'CHAT OFF'}
                  </span>
                  <button
                    type="button"
                    onClick={handleRunChatReply}
                    className="text-[10px] px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300 hover:text-white"
                  >
                    Rodar agora
                  </button>
                </div>
              </div>

              {/* Gemini Key */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Chave API do Gemini (Server-side)</label>
                <div className="relative">
                  <Lock className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500" />
                  <input
                    type="password"
                    placeholder="Injetada automaticamente ou personalizada..."
                    value={config.geminiApiKey}
                    onChange={(e) => setConfig({ ...config, geminiApiKey: e.target.value })}
                    className="w-full text-xs bg-slate-950 border border-slate-800 focus:border-cyan-500 outline-none rounded pl-8 pr-3 py-2 text-slate-200 font-mono"
                  />
                </div>
                <p className="text-[10px] text-slate-500 mt-1">Por padrão, usa a chave configurada nos Segredos do AI Studio.</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Modelo Gemini (custo)</label>
                <select
                  value={config.geminiModel || 'gemini-2.5-flash-lite'}
                  onChange={(e) => setConfig({ ...config, geminiModel: e.target.value })}
                  className="w-full text-xs bg-slate-950 border border-slate-800 focus:border-cyan-500 outline-none rounded p-2 text-slate-200"
                >
                  <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (mais barato)</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash (equilíbrio)</option>
                  <option value="gemini-3.5-flash">gemini-3.5-flash (mais capaz)</option>
                </select>
                <p className="text-[10px] text-slate-500 mt-1">Lite é suficiente para gerar propostas curtas em JSON.</p>
              </div>

              {/* Email Workana */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">E-mail de Login Workana</label>
                <div className="relative">
                  <User className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500" />
                  <input
                    type="email"
                    placeholder="email@exemplo.com"
                    value={config.freelasEmail}
                    onChange={(e) => setConfig({ ...config, freelasEmail: e.target.value })}
                    className="w-full text-xs bg-slate-950 border border-slate-800 focus:border-cyan-500 outline-none rounded pl-8 pr-3 py-2 text-slate-200"
                  />
                </div>
              </div>

              {/* Senha Workana */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Senha de Login Workana</label>
                <div className="relative">
                  <Lock className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Sua senha de acesso"
                    value={config.freelasPassword}
                    onChange={(e) => setConfig({ ...config, freelasPassword: e.target.value })}
                    className="w-full text-xs bg-slate-950 border border-slate-800 focus:border-cyan-500 outline-none rounded pl-8 pr-10 py-2 text-slate-200 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2 text-slate-400 hover:text-slate-200"
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Cookies */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Cookie de Sessão Workana</label>
                <textarea
                  placeholder="Opcional — sincronizado automaticamente pelo perfil persistente"
                  rows={2}
                  value={config.freelasSessionCookie}
                  onChange={(e) => setConfig({ ...config, freelasSessionCookie: e.target.value })}
                  className="w-full text-xs bg-slate-950 border border-slate-800 focus:border-cyan-500 outline-none rounded p-2 text-slate-200 font-mono resize-none"
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  Se o Cloudflare bloquear o login automático, faça login no <strong>Chrome normal</strong>, copie o cookie
                  <strong> workana_session</strong> do DevTools e cole aqui.
                </p>
                <button
                  type="button"
                  onClick={handleOpenLoginBrowser}
                  disabled={isOpeningLogin}
                  className="mt-2 w-full flex items-center justify-center gap-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2 px-3 rounded-lg transition-colors"
                >
                  <Lock className="w-3.5 h-3.5" />
                  {isOpeningLogin ? 'Aguardando login no browser...' : 'Login no Workana (Perfil Persistente)'}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {/* Max Daily Bids */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Limite Disparos/Dia</label>
                  <input
                    type="number"
                    value={config.maxProposalsPerDay}
                    onChange={(e) => setConfig({ ...config, maxProposalsPerDay: parseInt(e.target.value, 10) })}
                    className="w-full text-xs bg-slate-950 border border-slate-800 focus:border-cyan-500 outline-none rounded p-2 text-slate-200 text-center"
                    min={1}
                  />
                </div>

                {/* Headless check */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Modo Silencioso (Headless)</label>
                  <select
                    value={config.playwrightHeadless ? 'true' : 'false'}
                    onChange={(e) => setConfig({ ...config, playwrightHeadless: e.target.value === 'true' })}
                    className="w-full text-xs bg-slate-950 border border-slate-800 focus:border-cyan-500 outline-none rounded p-2 text-slate-200"
                  >
                    <option value="true">Headless (Sim)</option>
                    <option value="false">Ver Tela (Não)</option>
                  </select>
                </div>
              </div>

              {/* Keyword Filters Toggle */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-slate-200 block">Filtros Whitelist / Blacklist</label>
                    <span className="text-[10px] text-slate-400">Filtra projetos por palavras-chave na varredura e na IA</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, useKeywordFilters: !config.useKeywordFilters })}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${config.useKeywordFilters ? 'bg-cyan-500' : 'bg-slate-700'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${config.useKeywordFilters ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
                <div className="mt-2 text-center">
                  <span className={`text-[10px] px-2 py-0.5 font-bold rounded ${config.useKeywordFilters ? 'bg-cyan-950 text-cyan-400 border border-cyan-900' : 'bg-slate-900 text-slate-400 border border-slate-700'}`}>
                    {config.useKeywordFilters ? 'FILTROS ATIVOS' : 'FILTROS DESATIVADOS — TODOS OS PROJETOS PASSAM'}
                  </span>
                </div>
              </div>

              {/* Whitelist Keywords */}
              <div className={`border-t border-slate-800 pt-3 ${config.useKeywordFilters ? '' : 'opacity-50 pointer-events-none'}`}>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Palavras Whitelist (Filtro)</label>
                <div className="flex gap-1.5 mb-2">
                  <input
                    type="text"
                    placeholder="Adicionar..."
                    value={newWhitelistKeyword}
                    onChange={(e) => setNewWhitelistKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addWhitelistKeyword())}
                    className="flex-1 text-[11px] bg-slate-950 border border-slate-800 outline-none rounded p-1.5 text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={addWhitelistKeyword}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-cyan-400 font-bold rounded"
                  >
                    +
                  </button>
                </div>
                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto p-1 bg-slate-950/60 rounded border border-slate-800">
                  {config.whitelistKeywords.map(kw => (
                    <span key={kw} className="text-[9px] bg-slate-900 border border-cyan-950 text-cyan-400 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                      {kw}
                      <button type="button" onClick={() => removeWhitelistKeyword(kw)} className="text-rose-500 hover:text-rose-400 font-bold">×</button>
                    </span>
                  ))}
                  {config.whitelistKeywords.length === 0 && <span className="text-[9px] text-slate-600 block italic p-1">Nenhuma palavra adicionada</span>}
                </div>
              </div>

              {/* Blacklist Keywords */}
              <div className={`border-t border-slate-800 pt-3 ${config.useKeywordFilters ? '' : 'opacity-50 pointer-events-none'}`}>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Palavras Blacklist (Auto-Rejeição)</label>
                <div className="flex gap-1.5 mb-2">
                  <input
                    type="text"
                    placeholder="Adicionar..."
                    value={newBlacklistKeyword}
                    onChange={(e) => setNewBlacklistKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addBlacklistKeyword())}
                    className="flex-1 text-[11px] bg-slate-950 border border-slate-800 outline-none rounded p-1.5 text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={addBlacklistKeyword}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-rose-400 font-bold rounded"
                  >
                    +
                  </button>
                </div>
                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto p-1 bg-slate-950/60 rounded border border-slate-800">
                  {config.blacklistKeywords.map(kw => (
                    <span key={kw} className="text-[9px] bg-slate-900 border border-rose-950 text-rose-400 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                      {kw}
                      <button type="button" onClick={() => removeBlacklistKeyword(kw)} className="text-rose-500 hover:text-rose-400 font-bold">×</button>
                    </span>
                  ))}
                  {config.blacklistKeywords.length === 0 && <span className="text-[9px] text-slate-600 block italic p-1">Nenhuma palavra adicionada</span>}
                </div>
              </div>

              {/* Save Button */}
              <button
                type="submit"
                disabled={isSavingConfig}
                className="w-full mt-2 py-2.5 bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-slate-950 font-bold rounded shadow-lg transition flex items-center justify-center gap-2 text-xs"
              >
                {isSavingConfig ? <RefreshCw className="w-4.5 h-4.5 animate-spin" /> : <Save className="w-4.5 h-4.5" />}
                Salvar Configurações
              </button>

            </form>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              <RefreshCw className="w-5 h-5 animate-spin" />
            </div>
          )}

          {/* Quick Operations bar */}
          <div className="mt-auto border-t border-slate-800/80 pt-4 flex flex-col gap-2">
            <button
              onClick={handleResetDB}
              className="text-left text-[11px] text-rose-400/80 hover:text-rose-400 flex items-center gap-1.5 py-1 border border-rose-950 bg-rose-950/10 rounded px-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Resetar Banco de Dados
            </button>
          </div>
        </section>

        {/* PANEL 2: SCRAPED LEADS PIPELINE (xl:col-span-4) */}
        <section className="xl:col-span-4 bg-slate-900/40 border border-slate-800 rounded-xl p-5 flex flex-col overflow-hidden" id="leads-pipeline">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
            <h2 className="font-semibold text-sm tracking-wider uppercase text-slate-300 flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              Oportunidades Crawladas
            </h2>
            <button
              onClick={handleScrape}
              disabled={isScraping}
              className="py-1.5 px-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-extrabold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              {isScraping ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
              Scrape Workana
            </button>
          </div>

          {autoModeStatus.enabled && (
            <div className="mb-3 px-3 py-2 rounded-lg border border-emerald-900/60 bg-emerald-950/20 text-[10px] text-emerald-300 flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 shrink-0" />
              <span>
                Automático ativo: 1 proposta por vez — envio espaçado de ~{autoModeStatus.spacingSeconds?.submit || '45-90'}s.
                {(autoModeStatus.backlog.seen + autoModeStatus.backlog.pending + autoModeStatus.backlog.generating) > 0 &&
                  ` Fila: ${autoModeStatus.backlog.seen + autoModeStatus.backlog.pending + autoModeStatus.backlog.generating}.`}
              </span>
            </div>
          )}

          {/* Search filters panel */}
          <div className="flex flex-col sm:flex-row gap-2 mb-3 bg-slate-950 p-2 rounded-lg border border-slate-800/80">
            <div className="flex-1 relative">
              <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-slate-500" />
              <input
                type="text"
                placeholder="Buscar por termo..."
                value={keywordFilter}
                onChange={e => setKeywordFilter(e.target.value)}
                className="w-full text-xs bg-transparent outline-none pl-7 py-1.5 text-slate-200"
              />
            </div>
            <div className="relative flex items-center gap-1">
              <Filter className="w-3 h-3 text-slate-400" />
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="text-[11px] bg-slate-900 border border-slate-800 rounded px-1.5 py-1 outline-none text-slate-200 min-w-28"
              >
                <option value="all">Ver Todos</option>
                <option value="seen">Vistos</option>
                <option value="generating">Gerando</option>
                <option value="pending_review">Revisando</option>
                <option value="sent">Enviados</option>
                <option value="failed">Falhas</option>
              </select>
            </div>
          </div>

          {/* Projects lists */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 max-h-[calc(10*9rem+2.25rem)]">
            {filteredProjects.length > 10 && (
              <p className="text-[10px] text-slate-500 sticky top-0 z-10 bg-slate-900/95 backdrop-blur px-1 py-1 border-b border-slate-800/80">
                {filteredProjects.length} oportunidades — role para ver todas
              </p>
            )}
            {filteredProjects.map(project => {
              const isSelected = project.id === selectedProjectId;
              return (
                <div
                  key={project.id}
                  onClick={() => setSelectedProjectId(project.id)}
                  className={`border transition duration-200 rounded-lg p-3.5 cursor-pointer relative ${
                    isSelected 
                      ? 'bg-slate-900 border-cyan-500 shadow-md ring-1 ring-cyan-500/10' 
                      : 'bg-slate-900/40 hover:bg-slate-900/80 border-slate-800/80'
                  }`}
                >
                  <div className="flex justify-between items-start gap-2 mb-1.5">
                    <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold uppercase tracking-wider ${
                      project.status === ProjectStatus.SENT ? 'bg-emerald-950 text-emerald-400 border border-emerald-900' :
                      project.status === ProjectStatus.FAILED ? 'bg-rose-950 text-rose-400 border border-rose-900' :
                      project.status === ProjectStatus.PENDING_REVIEW ? 'bg-amber-950 text-amber-500 border border-amber-900' :
                      project.status === ProjectStatus.GENERATING ? 'bg-indigo-950 text-indigo-400 animate-pulse border border-indigo-900' :
                      'bg-slate-900 text-slate-400 border border-slate-850'
                    }`}>
                      {project.status === 'pending_review' ? 'Gatilho / Revisão' : project.status}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1 shrink-0">
                      <Clock className="w-3 h-3" />
                      {new Date(project.timestamp).toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>

                  <h3 className="font-bold text-xs leading-snug text-slate-100 hover:text-cyan-400 transition mb-2">
                    {project.title}
                  </h3>

                  <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mb-3">
                    {project.description}
                  </p>

                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {project.skills.slice(0, 4).map(skill => (
                      <span key={skill} className="text-[9px] bg-slate-950 border border-slate-850 text-slate-400 px-1.5 py-0.5 rounded">
                        {skill}
                      </span>
                    ))}
                  </div>

                  <div className="flex items-center justify-between border-t border-slate-850/60 pt-2 text-[11px]">
                    <span className="text-cyan-400 font-mono font-bold">{project.budget}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">Propostas: <b className="text-slate-200">{project.bidsCount}</b></span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProject(project.id);
                        }}
                        className="text-rose-500/80 hover:text-rose-400 p-0.5"
                        title="Remover projeto das listas"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredProjects.length === 0 && (
              <div className="h-44 flex flex-col items-center justify-center text-slate-500 border border-dashed border-slate-800 rounded-lg">
                <AlertCircle className="w-8 h-8 mb-2 text-slate-600" />
                <p className="text-xs">Nenhum projeto encontrado</p>
                <p className="text-[10px] text-slate-600 mt-0.5">Mude os filtros ou clique em Scrape.</p>
              </div>
            )}
          </div>
        </section>

        {/* PANEL 3: PROPOSAL WRITING REVIEW DESK (xl:col-span-5) */}
        <section className="xl:col-span-5 bg-slate-900/40 border border-slate-800 rounded-xl p-5 flex flex-col overflow-hidden" id="review-desk">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
            <h2 className="font-semibold text-sm tracking-wider uppercase text-slate-300 flex items-center gap-2">
              <Brain className="w-4 h-4 text-cyan-400" />
              Mesa de Análise e IA Sniper
            </h2>
            <span className="text-[10px] bg-indigo-950 text-indigo-400 px-2 py-0.5 rounded-full border border-indigo-900 font-mono font-semibold">
              Gemini Integrated
            </span>
          </div>

          {selectedProject ? (
            <div className="flex-1 flex flex-col overflow-y-auto space-y-4">
              
              {/* Selected project brief */}
              <div className="bg-slate-950 p-4 border border-slate-850 rounded-lg">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-mono text-cyan-400">{selectedProject.id}</span>
                  <a
                    href={selectedProject.url}
                    target="_blank"
                    referrerPolicy="no-referrer"
                    className="text-[10px] text-slate-400 hover:text-cyan-400 flex items-center gap-1 transition"
                  >
                    Visto no Workana
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </div>
                <h3 className="text-sm font-bold leading-snug mb-2 text-slate-100">{selectedProject.title}</h3>
                <p className="text-xs text-slate-400 leading-relaxed max-h-24 overflow-y-auto pr-1">
                  {selectedProject.description}
                </p>
                <div className="mt-3 flex items-center justify-between border-t border-slate-900 pt-2 text-xs">
                  <span className="text-slate-400">Orçamento: <b className="text-cyan-400">{selectedProject.budget}</b></span>
                  <span className="text-slate-400">Total Bides: <b className="text-slate-200">{selectedProject.bidsCount}</b></span>
                </div>
              </div>

              {/* Action row */}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleGenerateProposal}
                  disabled={isGenerating || selectedProject.status === ProjectStatus.GENERATING}
                  className="w-full py-2.5 bg-gradient-to-r from-cyan-500 via-indigo-600 to-indigo-700 hover:opacity-90 text-slate-950 font-black rounded shadow flex items-center justify-center gap-2 text-xs relative group overflow-hidden"
                >
                  <Sparkles className="w-4 h-4 text-slate-950 animate-pulse" />
                  {isGenerating ? 'Analisando briefing & Gerando Proposta...' : 'Gerar Proposta Estratégica com Gemini'}
                </button>
              </div>

              {/* Dynamic Proposal Workspace */}
              <div className="flex-1 flex flex-col space-y-3 min-h-[300px]">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    Proposta Sniper Gerada (Editável)
                  </label>
                  {editedProposal && (
                    <button
                      onClick={copyToClipboard}
                      className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                    >
                      <Copy className="w-3 h-3" />
                      Copiar Proposta
                    </button>
                  )}
                </div>

                <div className="flex-1 min-h-[160px] relative">
                  <textarea
                    value={editedProposal}
                    onChange={(e) => setEditedProposal(e.target.value)}
                    placeholder="Selecione um projeto e clique em 'Gerar Proposta' para redigir o briefing. Os lances de IA utilizam inteligência estrutural para serem curtos, assertivos e focados na dor do projeto."
                    className="w-full h-full min-h-[160px] text-xs bg-slate-950 border border-slate-850 p-3 rounded-lg text-slate-200 leading-relaxed outline-none focus:border-cyan-500/80 font-mono resize-none"
                  />
                  {isGenerating && (
                    <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center rounded-lg border border-cyan-500/30">
                      <div className="p-3 bg-gradient-to-tr from-cyan-400 to-indigo-600 rounded-full animate-bounce">
                        <Brain className="w-6 h-6 text-slate-950 animate-spin" />
                      </div>
                      <p className="text-xs font-bold text-cyan-400 mt-2.5 animate-pulse">Consultando cérebro neural do Gemini</p>
                      <p className="text-[10px] text-slate-500 mt-1">Garantindo foco estrito na dor do cliente, sem fluff.</p>
                    </div>
                  )}
                </div>

                {/* Price and Deliver Parameters */}
                <div className="grid grid-cols-2 gap-3 bg-slate-950 p-3.5 border border-slate-850 rounded-lg">
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">Preço Sugerido (R$ BRL)</label>
                    <input
                      type="number"
                      value={editedPrice}
                      onChange={(e) => setEditedPrice(parseFloat(e.target.value) || 0)}
                      className="w-full text-xs font-mono font-bold text-cyan-400 bg-slate-900 border border-slate-800 focus:border-cyan-500 outline-none rounded p-2"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">Prazo de Entrega (Dias)</label>
                    <input
                      type="number"
                      value={editedTime}
                      onChange={(e) => setEditedTime(parseInt(e.target.value, 10) || 0)}
                      className="w-full text-xs font-mono font-bold text-slate-300 bg-slate-900 border border-slate-800 focus:border-cyan-500 outline-none rounded p-2"
                    />
                  </div>
                </div>

                {/* Submissions & Dispatch decisions */}
                <div className="border-t border-slate-850 pt-3 flex flex-col sm:flex-row gap-2">
                  <button
                    type="button"
                    onClick={handleSaveProposalOverride}
                    disabled={!editedProposal}
                    className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded flex items-center justify-center gap-1.5 transition"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Salvar Alterações
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleSubmitProposalManualOverride(ProjectStatus.PENDING_REVIEW);
                      alert('Proposta homologada e adicionada na fila do submit-worker!');
                    }}
                    disabled={!editedProposal}
                    className="flex-1 py-2 bg-amber-500/20 hover:bg-amber-500 text-amber-400 hover:text-slate-950 disabled:opacity-50 text-xs font-black rounded border border-amber-500/40 flex items-center justify-center gap-1.5 transition"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    Aprovar & Enfileirar
                  </button>
                </div>

                {/* Immediate dispatcher simulator triggers */}
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => handleSubmitProposalManualOverride(ProjectStatus.SENT)}
                    disabled={!editedProposal}
                    className="text-[10px] text-emerald-400 hover:bg-emerald-950/20 border border-emerald-900/30 p-1.5 rounded bg-emerald-950/5 text-center flex items-center justify-center gap-1"
                  >
                    <CheckCircle className="w-3 h-3" />
                    Marcar como "Enviado"
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSubmitProposalManualOverride(ProjectStatus.FAILED)}
                    disabled={!editedProposal}
                    className="text-[10px] text-rose-400 hover:bg-rose-950/20 border border-rose-900/30 p-1.5 rounded bg-rose-950/5 text-center flex items-center justify-center gap-1"
                  >
                    <XCircle className="w-3 h-3" />
                    Marcar como "Falhou"
                  </button>
                </div>

              </div>

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 border border-dashed border-slate-800 rounded-lg">
              <Brain className="w-10 h-10 mb-2 text-slate-600 animate-pulse" />
              <p className="text-xs">Mesa de trabalho vazia</p>
              <p className="text-[10px] text-slate-600 mt-0.5">Selecione um projeto crawlado do feed ao lado para analisar.</p>
            </div>
          )}
        </section>

      </main>

      {/* LOWER SECTION: SYSTEM EXECUTION CONSOLE TRACE TERMINAL */}
      <footer className="h-56 border-t border-slate-800/80 bg-slate-950 p-4 flex flex-col shrink-0 z-30">
        <div className="flex items-center justify-between pb-2 border-b border-slate-900 mb-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-cyan-400 animate-pulse" />
            <span className="font-mono text-xs font-bold text-slate-300">Terminal Log Sniper Console</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-slate-500">Auto-refresh ativo</span>
            <button
              onClick={handleRunAutopilot}
              disabled={isRunningAutopilot || isRunningWorker}
              className="py-1 px-2 bg-gradient-to-r from-violet-600 to-cyan-600 text-white hover:from-violet-500 hover:to-cyan-500 disabled:opacity-50 font-bold font-mono text-[10px] rounded transition flex items-center gap-1 shadow"
            >
              {isRunningAutopilot ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Zap className="w-2.5 h-2.5" />}
              Autopilot 10x
            </button>
            <button
              onClick={handleTriggerWorker}
              disabled={isRunningWorker || isRunningAutopilot}
              className="py-1 px-2 bg-amber-500 text-slate-950 hover:bg-amber-400 disabled:opacity-50 font-bold font-mono text-[10px] rounded transition flex items-center gap-1 shadow"
            >
              {isRunningWorker ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Play className="w-2.5 h-2.5 fill-current" />}
              Submeter Fila (submit-worker)
            </button>
          </div>
        </div>

        {/* LOG LINES MONOSPACE PANEL */}
        <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed p-2.5 bg-slate-900/30 border border-slate-900 rounded space-y-1 select-text">
          {logs.map((log) => {
            let typeColor = 'text-slate-300';
            let prefix = '[-]';
            if (log.type === 'error') {
              typeColor = 'text-rose-400 font-semibold bg-rose-950/20 px-1 border-l-2 border-rose-500';
              prefix = '[x]';
            } else if (log.type === 'success') {
              typeColor = 'text-emerald-400 font-semibold bg-emerald-950/20 px-1 border-l-2 border-emerald-500';
              prefix = '[+]';
            } else if (log.type === 'warning') {
              typeColor = 'text-amber-400 bg-amber-950/20 px-1 border-l-2 border-amber-500';
              prefix = '[!]';
            } else if (log.type === 'info') {
              typeColor = 'text-sky-300';
              prefix = '[*]';
            }

            return (
              <div key={log.id} className="flex hover:bg-slate-900/30 py-0.5 rounded transition">
                <span className="text-slate-600 mr-2 select-none">
                  {new Date(log.timestamp).toLocaleTimeString('pt-BR')}
                </span>
                <span className={`${typeColor} break-all`}>
                  {prefix} {log.message}
                </span>
                {log.projectId && (
                  <button
                    onClick={() => setSelectedProjectId(log.projectId!)}
                    className="ml-2 text-cyan-500 underline select-none text-[9px] hover:text-cyan-400"
                  >
                    [Inspecionar]
                  </button>
                )}
              </div>
            );
          })}

          {logs.length === 0 && (
            <div className="text-slate-600 italic text-center py-4">Nenhum evento registrado no console do robô.</div>
          )}
        </div>
      </footer>

    </div>
  );
}
