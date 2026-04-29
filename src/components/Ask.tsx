'use client';

import React, {useState, useRef, useEffect, useCallback} from 'react';
import {FaChevronLeft, FaChevronRight } from 'react-icons/fa';
import Markdown from './Markdown';
import { useLanguage } from '@/contexts/LanguageContext';
import RepoInfo from '@/types/repoinfo';
import getRepoUrl from '@/utils/getRepoUrl';
import ModelSelectionModal from './ModelSelectionModal';
import { createChatWebSocket, closeWebSocket, ChatCompletionRequest } from '@/utils/websocketClient';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8001';
const INTERNAL_DEEP_RESEARCH_CONTINUE = '[DEEP RESEARCH] Continue the research';

interface Model {
  id: string;
  name: string;
}

interface Provider {
  id: string;
  name: string;
  models: Model[];
  supportsCustomModel?: boolean;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  tokenCount: number | null;
  createdAt: string;
}

interface ResearchStage {
  title: string;
  content: string;
  iteration: number;
  type: 'plan' | 'update' | 'conclusion';
}

interface AskProps {
  repoInfo: RepoInfo;
  provider?: string;
  model?: string;
  isCustomModel?: boolean;
  customModel?: string;
  language?: string;
  onRef?: (ref: { clearConversation: () => void }) => void;
}

const Ask: React.FC<AskProps> = ({
  repoInfo,
  provider = '',
  model = '',
  isCustomModel = false,
  customModel = '',
  language = 'en',
  onRef
}) => {
  const [question, setQuestion] = useState('');
  const [response, setResponse] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [deepResearch, setDeepResearch] = useState(false);

  // Model selection state
  const [selectedProvider, setSelectedProvider] = useState(provider);
  const [selectedModel, setSelectedModel] = useState(model);
  const [isCustomSelectedModel, setIsCustomSelectedModel] = useState(isCustomModel);
  const [customSelectedModel, setCustomSelectedModel] = useState(customModel);
  const [isModelSelectionModalOpen, setIsModelSelectionModalOpen] = useState(false);
  const [isComprehensiveView, setIsComprehensiveView] = useState(true);

  // Get language context for translations
  const { messages } = useLanguage();

  // Research navigation state
  const [researchStages, setResearchStages] = useState<ResearchStage[]>([]);
  const [currentStageIndex, setCurrentStageIndex] = useState(0);
  const [conversationHistory, setConversationHistory] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [researchIteration, setResearchIteration] = useState(0);
  const [researchComplete, setResearchComplete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef(provider);
  const modelRef = useRef(model);

  // Focus input on component mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // Expose clearConversation method to parent component
  useEffect(() => {
    if (onRef) {
      onRef({ clearConversation });
    }
  }, [onRef, clearConversation]);

  // Scroll to bottom of response when it changes
  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [conversationHistory, response, isMessagesLoading, isLoading]);

  // Close WebSocket when component unmounts
  useEffect(() => {
    return () => {
      closeWebSocket(webSocketRef.current);
    };
  }, []);

  useEffect(() => {
    providerRef.current = provider;
    modelRef.current = model;
  }, [provider, model]);

  useEffect(() => {
    const fetchModel = async () => {
      try {
        setIsLoading(true);

        const response = await fetch('/api/models/config');
        if (!response.ok) {
          throw new Error(`Error fetching model configurations: ${response.status}`);
        }

        const data = await response.json();

        // use latest provider/model ref to check
        if(providerRef.current == '' || modelRef.current== '') {
          setSelectedProvider(data.defaultProvider);

          // Find the default provider and set its default model
          const selectedProvider = data.providers.find((p:Provider) => p.id === data.defaultProvider);
          if (selectedProvider && selectedProvider.models.length > 0) {
            setSelectedModel(selectedProvider.models[0].id);
          }
        } else {
          setSelectedProvider(providerRef.current);
          setSelectedModel(modelRef.current);
        }
      } catch (err) {
        console.error('Failed to fetch model configurations:', err);
      } finally {
        setIsLoading(false);
      }
    };
    if(provider == '' || model == '') {
      fetchModel()
    }
  }, [provider, model]);

  const getAuthToken = useCallback(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    return localStorage.getItem('cw_token') || '';
  }, []);

  const getAuthHeaders = useCallback(() => {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [getAuthToken]);

  const resetConversationState = useCallback(() => {
    setQuestion('');
    setResponse('');
    setConversationHistory([]);
    setResearchIteration(0);
    setResearchComplete(false);
    setResearchStages([]);
    setCurrentStageIndex(0);
    setIsLoading(false);
    setHistoryError(null);
    closeWebSocket(webSocketRef.current);
  }, []);

  const clearConversation = useCallback(() => {
    resetConversationState();
    setSelectedConversationId(null);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, [resetConversationState]);

  const formatTimestamp = (value: string) => {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  const loadConversationMessages = useCallback(async (conversationId: string) => {
    const token = getAuthToken();
    if (!token) {
      setConversationHistory([]);
      return;
    }
    setIsMessagesLoading(true);
    setHistoryError(null);
    setIsLoading(false);
    closeWebSocket(webSocketRef.current);
    try {
      setResponse('');
      const response = await fetch(`${API_BASE}/conversations/${conversationId}/messages`, {
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        }
      });
      if (!response.ok) {
        throw new Error(`Failed to load messages: ${response.status}`);
      }
      const data: ConversationMessageRecord[] = await response.json();
      const history = data.map((msg) => ({
        role: msg.role,
        content: msg.content
      })) as Message[];
      setConversationHistory(history);
      const lastAssistant = data.slice().reverse().find((msg) => msg.role === 'assistant');
      setResponse(lastAssistant?.content || '');
      setResearchStages([]);
      setCurrentStageIndex(0);
      setResearchIteration(0);
      setResearchComplete(false);
    } catch (error) {
      console.error('Failed to load conversation messages:', error);
      setHistoryError(messages.ask?.historyLoadError || 'Failed to load conversations.');
    } finally {
      setIsMessagesLoading(false);
    }
  }, [getAuthHeaders, getAuthToken, messages.ask?.historyLoadError]);

  const loadConversations = useCallback(async () => {
    const token = getAuthToken();
    if (!token) {
      setConversations([]);
      setHistoryError(null);
      return;
    }

    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      const params = new URLSearchParams({
        repoOwner: repoInfo.owner,
        repoName: repoInfo.repo,
        repoType: repoInfo.type || 'github'
      });
      const response = await fetch(`${API_BASE}/conversations?${params.toString()}`, {
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        }
      });
      if (!response.ok) {
        throw new Error(`Failed to load conversations: ${response.status}`);
      }
      const data: ConversationSummary[] = await response.json();
      setConversations(data);
      if (!selectedConversationId && data.length > 0) {
        setSelectedConversationId(data[0].id);
        void loadConversationMessages(data[0].id);
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
      setHistoryError(messages.ask?.historyLoadError || 'Failed to load conversations.');
    } finally {
      setIsHistoryLoading(false);
    }
  }, [
    getAuthHeaders,
    getAuthToken,
    loadConversationMessages,
    messages.ask?.historyLoadError,
    repoInfo.owner,
    repoInfo.repo,
    repoInfo.type,
    selectedConversationId
  ]);

  const createConversation = async (title: string): Promise<ConversationSummary | null> => {
    const token = getAuthToken();
    if (!token) {
      return null;
    }
    try {
      const response = await fetch(`${API_BASE}/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({
          repoOwner: repoInfo.owner,
          repoName: repoInfo.repo,
          repoType: repoInfo.type || 'github',
          title: title.slice(0, 120)
        })
      });
      if (!response.ok) {
        throw new Error(`Failed to create conversation: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Failed to create conversation:', error);
      return null;
    }
  };

  const persistConversationMessage = async (conversationId: string, message: Message) => {
    const token = getAuthToken();
    if (!token) {
      return;
    }
    try {
      await fetch(`${API_BASE}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({
          role: message.role,
          content: message.content
        })
      });
    } catch (error) {
      console.error('Failed to persist conversation message:', error);
    }
  };

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);
  const downloadresponse = () =>{
  const content = response || conversationHistory.slice().reverse().find(msg => msg.role === 'assistant')?.content || '';
  if (!content) {
    return;
  }
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `response-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

  // Function to check if research is complete based on response content
  const checkIfResearchComplete = (content: string): boolean => {
    // Check for explicit final conclusion markers
    if (content.includes('## Final Conclusion')) {
      return true;
    }

    // Check for conclusion sections that don't indicate further research
    if ((content.includes('## Conclusion') || content.includes('## Summary')) &&
      !content.includes('I will now proceed to') &&
      !content.includes('Next Steps') &&
      !content.includes('next iteration')) {
      return true;
    }

    // Check for phrases that explicitly indicate completion
    if (content.includes('This concludes our research') ||
      content.includes('This completes our investigation') ||
      content.includes('This concludes the deep research process') ||
      content.includes('Key Findings and Implementation Details') ||
      content.includes('In conclusion,') ||
      (content.includes('Final') && content.includes('Conclusion'))) {
      return true;
    }

    // Check for topic-specific completion indicators
    if (content.includes('Dockerfile') &&
      (content.includes('This Dockerfile') || content.includes('The Dockerfile')) &&
      !content.includes('Next Steps') &&
      !content.includes('In the next iteration')) {
      return true;
    }

    return false;
  };

  // Function to extract research stages from the response
  const extractResearchStage = (content: string, iteration: number): ResearchStage | null => {
    // Check for research plan (first iteration)
    if (iteration === 1 && content.includes('## Research Plan')) {
      const planMatch = content.match(/## Research Plan([\s\S]*?)(?:## Next Steps|$)/);
      if (planMatch) {
        return {
          title: 'Research Plan',
          content: content,
          iteration: 1,
          type: 'plan'
        };
      }
    }

    // Check for research updates (iterations 1-4)
    if (iteration >= 1 && iteration <= 4) {
      const updateMatch = content.match(new RegExp(`## Research Update ${iteration}([\\s\\S]*?)(?:## Next Steps|$)`));
      if (updateMatch) {
        return {
          title: `Research Update ${iteration}`,
          content: content,
          iteration: iteration,
          type: 'update'
        };
      }
    }

    // Check for final conclusion
    if (content.includes('## Final Conclusion')) {
      const conclusionMatch = content.match(/## Final Conclusion([\s\S]*?)$/);
      if (conclusionMatch) {
        return {
          title: 'Final Conclusion',
          content: content,
          iteration: iteration,
          type: 'conclusion'
        };
      }
    }

    return null;
  };

  // Function to navigate to a specific research stage
  const navigateToStage = (index: number) => {
    if (index >= 0 && index < researchStages.length) {
      setCurrentStageIndex(index);
    }
  };

  // Function to navigate to the next research stage
  const navigateToNextStage = () => {
    if (currentStageIndex < researchStages.length - 1) {
      navigateToStage(currentStageIndex + 1);
    }
  };

  // Function to navigate to the previous research stage
  const navigateToPreviousStage = () => {
    if (currentStageIndex > 0) {
      navigateToStage(currentStageIndex - 1);
    }
  };

  // WebSocket reference
  const webSocketRef = useRef<WebSocket | null>(null);

  // Function to continue research automatically
  const continueResearch = async () => {
    if (!deepResearch || researchComplete || !response || isLoading) return;

    // Add a small delay to allow the user to read the current response
    await new Promise(resolve => setTimeout(resolve, 2000));

    setIsLoading(true);

    try {
      const activeConversationId = selectedConversationId;
      const requestMessages: Message[] = [
        ...conversationHistory,
        {
          role: 'user',
          content: INTERNAL_DEEP_RESEARCH_CONTINUE
        }
      ];
      setConversationHistory(requestMessages);

      // Increment research iteration
      const newIteration = researchIteration + 1;
      setResearchIteration(newIteration);

      // Clear previous response
      setResponse('');

      // Prepare the request body
      const requestBody: ChatCompletionRequest = {
        repo_url: getRepoUrl(repoInfo),
        type: repoInfo.type,
        messages: requestMessages.map(msg => ({ role: msg.role as 'user' | 'assistant', content: msg.content })),
        provider: selectedProvider,
        model: isCustomSelectedModel ? customSelectedModel : selectedModel,
        language: language
      };

      // Add tokens if available
      if (repoInfo?.token) {
        requestBody.token = repoInfo.token;
      }

      // Close any existing WebSocket connection
      closeWebSocket(webSocketRef.current);

      let fullResponse = '';

      // Create a new WebSocket connection
      webSocketRef.current = createChatWebSocket(
        requestBody,
        // Message handler
        (message: string) => {
          fullResponse += message;
          setResponse(fullResponse);

          // Extract research stage if this is a deep research response
          if (deepResearch) {
            const stage = extractResearchStage(fullResponse, newIteration);
            if (stage) {
              // Add the stage to the research stages if it's not already there
              setResearchStages(prev => {
                // Check if we already have this stage
                const existingStageIndex = prev.findIndex(s => s.iteration === stage.iteration && s.type === stage.type);
                if (existingStageIndex >= 0) {
                  // Update existing stage
                  const newStages = [...prev];
                  newStages[existingStageIndex] = stage;
                  return newStages;
                } else {
                  // Add new stage
                  return [...prev, stage];
                }
              });

              // Update current stage index to the latest stage
              setCurrentStageIndex(researchStages.length);
            }
          }
        },
        // Error handler
        (error: Event) => {
          console.error('WebSocket error:', error);
          setResponse(prev => prev + '\n\nError: WebSocket connection failed. Falling back to HTTP...');

          // Fallback to HTTP if WebSocket fails
          fallbackToHttp(requestBody, activeConversationId);
        },
        // Close handler
        () => {
          // Check if research is complete when the WebSocket closes
          const isComplete = checkIfResearchComplete(fullResponse);

          // Force completion after a maximum number of iterations (5)
          const forceComplete = newIteration >= 5;

          if (forceComplete && !isComplete) {
            // If we're forcing completion, append a comprehensive conclusion to the response
            const completionNote = "\n\n## Final Conclusion\nAfter multiple iterations of deep research, we've gathered significant insights about this topic. This concludes our investigation process, having reached the maximum number of research iterations. The findings presented across all iterations collectively form our comprehensive answer to the original question.";
            fullResponse += completionNote;
            setResponse(fullResponse);
            setResearchComplete(true);
          } else {
            setResearchComplete(isComplete);
          }

          if (fullResponse) {
            setConversationHistory(prev => [...prev, { role: 'assistant', content: fullResponse }]);
            if (activeConversationId) {
              void persistConversationMessage(activeConversationId, { role: 'assistant', content: fullResponse });
              void loadConversations();
            }
          }

          setIsLoading(false);
        }
      );
    } catch (error) {
      console.error('Error during API call:', error);
      setResponse(prev => prev + '\n\nError: Failed to continue research. Please try again.');
      setResearchComplete(true);
      setIsLoading(false);
    }
  };

  // Fallback to HTTP if WebSocket fails
  const fallbackToHttp = async (requestBody: ChatCompletionRequest, conversationId: string | null) => {
    try {
      // Make the API call using HTTP
      const apiResponse = await fetch(`/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!apiResponse.ok) {
        throw new Error(`API error: ${apiResponse.status}`);
      }

      // Process the streaming response
      const reader = apiResponse.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('Failed to get response reader');
      }

      // Read the stream
      let fullResponse = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullResponse += chunk;
        setResponse(fullResponse);

        // Extract research stage if this is a deep research response
        if (deepResearch) {
          const stage = extractResearchStage(fullResponse, researchIteration);
          if (stage) {
            // Add the stage to the research stages
            setResearchStages(prev => {
              const existingStageIndex = prev.findIndex(s => s.iteration === stage.iteration && s.type === stage.type);
              if (existingStageIndex >= 0) {
                const newStages = [...prev];
                newStages[existingStageIndex] = stage;
                return newStages;
              } else {
                return [...prev, stage];
              }
            });
          }
        }
      }

      // Check if research is complete
      const isComplete = checkIfResearchComplete(fullResponse);

      // Force completion after a maximum number of iterations (5)
      const forceComplete = researchIteration >= 5;

      if (forceComplete && !isComplete) {
        // If we're forcing completion, append a comprehensive conclusion to the response
        const completionNote = "\n\n## Final Conclusion\nAfter multiple iterations of deep research, we've gathered significant insights about this topic. This concludes our investigation process, having reached the maximum number of research iterations. The findings presented across all iterations collectively form our comprehensive answer to the original question.";
        fullResponse += completionNote;
        setResponse(fullResponse);
        setResearchComplete(true);
      } else {
        setResearchComplete(isComplete);
      }

      if (fullResponse) {
        setConversationHistory(prev => [...prev, { role: 'assistant', content: fullResponse }]);
        if (conversationId) {
          void persistConversationMessage(conversationId, { role: 'assistant', content: fullResponse });
          void loadConversations();
        }
      }
    } catch (error) {
      console.error('Error during HTTP fallback:', error);
      setResponse(prev => prev + '\n\nError: Failed to get a response. Please try again.');
      setResearchComplete(true);
    } finally {
      setIsLoading(false);
    }
  };

  // Effect to continue research when response is updated
  useEffect(() => {
    if (deepResearch && response && !isLoading && !researchComplete) {
      const isComplete = checkIfResearchComplete(response);
      if (isComplete) {
        setResearchComplete(true);
      } else if (researchIteration > 0 && researchIteration < 5) {
        // Only auto-continue if we're already in a research process and haven't reached max iterations
        // Use setTimeout to avoid potential infinite loops
        const timer = setTimeout(() => {
          continueResearch();
        }, 1000);
        return () => clearTimeout(timer);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response, isLoading, deepResearch, researchComplete, researchIteration]);

  // Effect to update research stages when the response changes
  useEffect(() => {
    if (deepResearch && response && !isLoading) {
      // Try to extract a research stage from the response
      const stage = extractResearchStage(response, researchIteration);
      if (stage) {
        // Add or update the stage in the research stages
        setResearchStages(prev => {
          // Check if we already have this stage
          const existingStageIndex = prev.findIndex(s => s.iteration === stage.iteration && s.type === stage.type);
          if (existingStageIndex >= 0) {
            // Update existing stage
            const newStages = [...prev];
            newStages[existingStageIndex] = stage;
            return newStages;
          } else {
            // Add new stage
            return [...prev, stage];
          }
        });

        // Update current stage index to point to this stage
        setCurrentStageIndex(prev => {
          const newIndex = researchStages.findIndex(s => s.iteration === stage.iteration && s.type === stage.type);
          return newIndex >= 0 ? newIndex : prev;
        });
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response, isLoading, deepResearch, researchIteration]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!question.trim() || isLoading) return;

    handleConfirmAsk();
  };

  // Handle confirm and send request
  const handleConfirmAsk = async () => {
    setIsLoading(true);
    setResponse('');
    setResearchIteration(0);
    setResearchComplete(false);
    setResearchStages([]);
    setCurrentStageIndex(0);

    try {
      // Create initial message
      const initialMessage: Message = {
        role: 'user',
        content: deepResearch ? `[DEEP RESEARCH] ${question}` : question
      };

      // Set initial conversation history
      const baseHistory = stripInternalMessages(conversationHistory);
      const newHistory: Message[] = [...baseHistory, initialMessage];
      setConversationHistory(newHistory);
      setQuestion('');

      let activeConversationId = selectedConversationId;
      if (!activeConversationId) {
        const createdConversation = await createConversation(question.trim());
        if (createdConversation) {
          activeConversationId = createdConversation.id;
          setSelectedConversationId(createdConversation.id);
          setConversations(prev => [
            createdConversation,
            ...prev.filter(item => item.id !== createdConversation.id)
          ]);
        }
      }

      if (activeConversationId) {
        await persistConversationMessage(activeConversationId, initialMessage);
      }

      // Prepare request body
      const requestBody: ChatCompletionRequest = {
        repo_url: getRepoUrl(repoInfo),
        type: repoInfo.type,
        messages: newHistory.map(msg => ({ role: msg.role as 'user' | 'assistant', content: msg.content })),
        provider: selectedProvider,
        model: isCustomSelectedModel ? customSelectedModel : selectedModel,
        language: language
      };

      // Add tokens if available
      if (repoInfo?.token) {
        requestBody.token = repoInfo.token;
      }

      // Close any existing WebSocket connection
      closeWebSocket(webSocketRef.current);

      let fullResponse = '';

      // Create a new WebSocket connection
      webSocketRef.current = createChatWebSocket(
        requestBody,
        // Message handler
        (message: string) => {
          fullResponse += message;
          setResponse(fullResponse);

          // Extract research stage if this is a deep research response
          if (deepResearch) {
            const stage = extractResearchStage(fullResponse, 1); // First iteration
            if (stage) {
              // Add the stage to the research stages
              setResearchStages([stage]);
              setCurrentStageIndex(0);
            }
          }
        },
        // Error handler
        (error: Event) => {
          console.error('WebSocket error:', error);
          setResponse(prev => prev + '\n\nError: WebSocket connection failed. Falling back to HTTP...');

          // Fallback to HTTP if WebSocket fails
          fallbackToHttp(requestBody, activeConversationId);
        },
        // Close handler
        () => {
          if (fullResponse) {
            setConversationHistory(prev => [...prev, { role: 'assistant', content: fullResponse }]);
            if (activeConversationId) {
              void persistConversationMessage(activeConversationId, { role: 'assistant', content: fullResponse });
              void loadConversations();
            }
          }

          // If deep research is enabled, check if we should continue
          if (deepResearch) {
            const isComplete = checkIfResearchComplete(fullResponse);
            setResearchComplete(isComplete);

            // If not complete, start the research process
            if (!isComplete) {
              setResearchIteration(1);
              // The continueResearch function will be triggered by the useEffect
            }
          }

          setIsLoading(false);
        }
      );
    } catch (error) {
      console.error('Error during API call:', error);
      setResponse(prev => prev + '\n\nError: Failed to get a response. Please try again.');
      setResearchComplete(true);
      setIsLoading(false);
    }
  };

  const [buttonWidth, setButtonWidth] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Measure button width and update state
  useEffect(() => {
    if (buttonRef.current) {
      const width = buttonRef.current.offsetWidth;
      setButtonWidth(width);
    }
  }, [messages.ask?.askButton, isLoading]);

  const stripInternalMessages = (history: Message[]) =>
    history.filter(msg => msg.content !== INTERNAL_DEEP_RESEARCH_CONTINUE);
  const displayMessages = stripInternalMessages(conversationHistory).filter(
    msg => msg.role !== 'system'
  );
  const showStreamingResponse =
    isLoading || (!!response && displayMessages[displayMessages.length - 1]?.role !== 'assistant');
  const formatUserContent = (content: string) => {
    if (content.startsWith('[DEEP RESEARCH]')) {
      return content.replace('[DEEP RESEARCH]', '').trim();
    }
    return content;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-full flex-col gap-4 md:flex-row">
        <aside className="md:w-64 w-full shrink-0 border border-[var(--border-color)]/40 rounded-lg bg-[var(--background)]/40 p-3 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-[var(--foreground)]">
              {messages.ask?.historyTitle || '对话历史'}
            </span>
            <button
              type="button"
              onClick={clearConversation}
              className="text-xs text-[var(--accent-primary)] hover:text-[var(--highlight)]"
            >
              {messages.ask?.newConversation || '新对话'}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {isHistoryLoading && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {messages.ask?.loadingHistory || '正在加载...'}
              </div>
            )}
            {historyError && !isHistoryLoading && (
              <div className="text-xs text-red-500">{historyError}</div>
            )}
            {!isHistoryLoading && !historyError && conversations.length === 0 && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {messages.ask?.emptyHistory || '暂无历史对话'}
              </div>
            )}
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => {
                  setSelectedConversationId(conversation.id);
                  void loadConversationMessages(conversation.id);
                }}
                className={`w-full text-left p-2 rounded-md border transition-colors ${
                  conversation.id === selectedConversationId
                    ? 'border-[var(--accent-primary)]/60 bg-[var(--background)]/70'
                    : 'border-transparent hover:border-[var(--border-color)]/40 hover:bg-[var(--background)]/60'
                }`}
              >
                <div className="text-xs font-medium text-[var(--foreground)] truncate">
                  {conversation.title || messages.ask?.untitledConversation || '未命名对话'}
                </div>
                <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                  {formatTimestamp(conversation.updatedAt)}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-end mb-3">
            {/* Model selection button */}
            <button
              type="button"
              onClick={() => setIsModelSelectionModalOpen(true)}
              className="text-xs px-2.5 py-1 rounded border border-[var(--border-color)]/40 bg-[var(--background)]/10 text-[var(--foreground)]/80 hover:bg-[var(--background)]/30 hover:text-[var(--foreground)] transition-colors flex items-center gap-1.5"
            >
              <span>{selectedProvider}/{isCustomSelectedModel ? customSelectedModel : selectedModel}</span>
              <svg className="h-3.5 w-3.5 text-[var(--accent-primary)]/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          </div>

          <div
            ref={responseRef}
            className="flex-1 overflow-y-auto rounded-lg border border-[var(--border-color)]/40 bg-[var(--background)]/30 p-4 space-y-4"
          >
            {isMessagesLoading && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {messages.ask?.loadingConversation || '加载对话中...'}
              </div>
            )}
            {!isMessagesLoading && displayMessages.length === 0 && !showStreamingResponse && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {messages.ask?.emptyConversation || '开始新的对话吧！'}
              </div>
            )}
            {displayMessages.map((msg, index) => (
              <div
                key={`${msg.role}-${index}`}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-4 py-2 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[var(--accent-primary)] text-white'
                      : 'bg-[var(--background)]/80 border border-[var(--border-color)]/40 text-[var(--foreground)]'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <Markdown content={msg.content} />
                  ) : (
                    <p className="whitespace-pre-wrap">{formatUserContent(msg.content)}</p>
                  )}
                </div>
              </div>
            ))}
            {showStreamingResponse && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg px-4 py-2 text-sm leading-relaxed bg-[var(--background)]/80 border border-[var(--border-color)]/40 text-[var(--foreground)]">
                  {response ? (
                    <Markdown content={response} />
                  ) : (
                    <div className="flex items-center space-x-2">
                      <div className="animate-pulse flex space-x-1">
                        <div className="h-2 w-2 bg-purple-600 rounded-full"></div>
                        <div className="h-2 w-2 bg-purple-600 rounded-full"></div>
                        <div className="h-2 w-2 bg-purple-600 rounded-full"></div>
                      </div>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {deepResearch
                          ? (researchIteration === 0
                            ? (messages.ask?.planningResearch || '规划研究方案...')
                            : (messages.ask?.researchIterationInProgress?.replace('{n}', String(researchIteration)) || `第 ${researchIteration} 轮研究进行中...`))
                          : (messages.ask?.thinking || '思考中...')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {deepResearch && researchStages.length > 0 && (
            <div className="mt-3 border border-[var(--border-color)]/40 rounded-lg bg-[var(--background)]/20 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  {messages.ask?.researchStages || '研究阶段'}
                </div>
                {researchStages.length > 1 && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => navigateToPreviousStage()}
                      disabled={currentStageIndex === 0}
                      className={`p-1 rounded-md ${currentStageIndex === 0 ? 'text-gray-400 dark:text-gray-600' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                      aria-label="Previous stage"
                    >
                      <FaChevronLeft size={12} />
                    </button>
                    <div className="text-xs text-gray-600 dark:text-gray-400">
                      {currentStageIndex + 1} / {researchStages.length}
                    </div>
                    <button
                      onClick={() => navigateToNextStage()}
                      disabled={currentStageIndex === researchStages.length - 1}
                      className={`p-1 rounded-md ${currentStageIndex === researchStages.length - 1 ? 'text-gray-400 dark:text-gray-600' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                      aria-label="Next stage"
                    >
                      <FaChevronRight size={12} />
                    </button>
                  </div>
                )}
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                {researchStages[currentStageIndex]?.title || `Stage ${currentStageIndex + 1}`}
              </div>
              {researchStages[currentStageIndex] && (
                <div className="prose dark:prose-invert max-w-none text-sm">
                  <Markdown content={researchStages[currentStageIndex].content} />
                </div>
              )}
            </div>
          )}

          {(displayMessages.length > 0 || response) && (
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {/* Download button */}
                <button
                  onClick={downloadresponse}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400 px-2 py-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center gap-1"
                  title="下载响应为Markdown文件"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  {messages.ask?.download || '下载'}
                </button>

                {/* Clear button */}
                <button
                  id="ask-clear-conversation"
                  onClick={clearConversation}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 px-2 py-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  {messages.ask?.clearConversation || '清除对话'}
                </button>
              </div>
              {deepResearch && (
                <div className="text-xs text-purple-600 dark:text-purple-400">
                  {messages.ask?.multiTurnEnabled || '已启用多轮研究流程'}
                  {researchIteration > 0 && !researchComplete && ` (${messages.ask?.iteration?.replace('{n}', String(researchIteration)) || `第 ${researchIteration} 轮`})`}
                  {researchComplete && ` (${messages.ask?.complete || '已完成'})`}
                </div>
              )}
            </div>
          )}

          {/* Question input */}
          <form onSubmit={handleSubmit} className="mt-4">
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={messages.ask?.placeholder || 'What would you like to know about this codebase?'}
                className="block w-full rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[var(--foreground)] px-5 py-3.5 text-base shadow-sm focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:outline-none transition-all"
                style={{ paddingRight: `${buttonWidth + 24}px` }}
                disabled={isLoading}
              />
              <button
                ref={buttonRef}
                type="submit"
                disabled={isLoading || !question.trim()}
                className={`absolute right-3 top-1/2 transform -translate-y-1/2 px-4 py-2 rounded-md font-medium text-sm ${
                  isLoading || !question.trim()
                    ? 'bg-[var(--button-disabled-bg)] text-[var(--button-disabled-text)] cursor-not-allowed'
                    : 'bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary)]/90 shadow-sm'
                } transition-all duration-200 flex items-center gap-1.5`}
              >
                {isLoading ? (
                  <div className="w-4 h-4 rounded-full border-2 border-t-transparent border-white animate-spin" />
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                    </svg>
                    <span>{messages.ask?.askButton || 'Ask'}</span>
                  </>
                )}
              </button>
            </div>

            {/* Deep Research toggle */}
            <div className="flex items-center mt-2 justify-between">
              <div className="group relative">
                <label className="flex items-center cursor-pointer">
                  <span className="text-xs text-gray-600 dark:text-gray-400 mr-2">{messages.ask?.deepResearch || '深度研究'}</span>
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={deepResearch}
                      onChange={() => setDeepResearch(!deepResearch)}
                      className="sr-only"
                    />
                    <div className={`w-10 h-5 rounded-full transition-colors ${deepResearch ? 'bg-purple-600' : 'bg-gray-300 dark:bg-gray-600'}`}></div>
                    <div className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white transition-transform transform ${deepResearch ? 'translate-x-5' : ''}`}></div>
                  </div>
                </label>
                <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block bg-gray-800 text-white text-xs rounded p-2 w-72 z-10">
                  <div className="relative">
                    <div className="absolute -bottom-2 left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-800"></div>
                    <p className="mb-1">{messages.ask?.deepResearchTooltip || '深度研究进行多轮调查：'}</p>
                    <ul className="list-disc pl-4 text-xs">
                      <li><strong>初始研究：</strong>{messages.ask?.initialResearch || '制定研究计划和初步发现'}</li>
                      <li><strong>第1轮：</strong>{messages.ask?.iteration1 || '深入探索特定方面'}</li>
                      <li><strong>第2轮：</strong>{messages.ask?.iteration2 || '调查剩余问题'}</li>
                      <li><strong>第3-4轮：</strong>{messages.ask?.iterations3to4 || '深入研究复杂领域'}</li>
                      <li><strong>最终结论：</strong>{messages.ask?.finalConclusion || '基于所有轮次的综合答案'}</li>
                    </ul>
                    <p className="mt-1 text-xs italic">{messages.ask?.autoResearchNote || 'AI会自动继续研究直到完成（最多5轮）'}</p>
                  </div>
                </div>
              </div>
              {deepResearch && (
                <div className="text-xs text-purple-600 dark:text-purple-400">
                  {messages.ask?.multiTurnEnabled || '已启用多轮研究流程'}
                  {researchIteration > 0 && !researchComplete && ` (${messages.ask?.iteration?.replace('{n}', String(researchIteration)) || `第 ${researchIteration} 轮`})`}
                  {researchComplete && ` (${messages.ask?.complete || '已完成'})`}
                </div>
              )}
            </div>
          </form>
        </div>
      </div>

      {/* Model Selection Modal */}
      <ModelSelectionModal
        isOpen={isModelSelectionModalOpen}
        onClose={() => setIsModelSelectionModalOpen(false)}
        provider={selectedProvider}
        setProvider={setSelectedProvider}
        model={selectedModel}
        setModel={setSelectedModel}
        isCustomModel={isCustomSelectedModel}
        setIsCustomModel={setIsCustomSelectedModel}
        customModel={customSelectedModel}
        setCustomModel={setCustomSelectedModel}
        isComprehensiveView={isComprehensiveView}
        setIsComprehensiveView={setIsComprehensiveView}
        showFileFilters={false}
        onApply={() => {
          console.log('Model selection applied:', selectedProvider, selectedModel);
        }}
        showWikiType={false}
        authRequired={false}
        isAuthLoading={false}
      />
    </div>
  );
};

export default Ask;
