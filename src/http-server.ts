/**
 * GoHighLevel MCP HTTP Server
 * HTTP version for ChatGPT web integration
 */

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { 
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError 
} from '@modelcontextprotocol/sdk/types.js';
import * as dotenv from 'dotenv';

import { GHLApiClient } from './clients/ghl-api-client';
import { ContactTools } from './tools/contact-tools';
import { ConversationTools } from './tools/conversation-tools';
import { BlogTools } from './tools/blog-tools';
import { OpportunityTools } from './tools/opportunity-tools';
import { CalendarTools } from './tools/calendar-tools';
import { EmailTools } from './tools/email-tools';
import { LocationTools } from './tools/location-tools';
import { EmailISVTools } from './tools/email-isv-tools';
import { SocialMediaTools } from './tools/social-media-tools';
import { MediaTools } from './tools/media-tools';
import { ObjectTools } from './tools/object-tools';
import { AssociationTools } from './tools/association-tools';
import { CustomFieldV2Tools } from './tools/custom-field-v2-tools';
import { WorkflowTools } from './tools/workflow-tools';
import { SurveyTools } from './tools/survey-tools';
import { StoreTools } from './tools/store-tools';
import { ProductsTools } from './tools/products-tools.js';
import { GHLConfig } from './types/ghl-types';

// Load environment variables
dotenv.config();

/**
 * HTTP MCP Server class for web deployment
 */
class GHLMCPHttpServer {
  private app: express.Application;
  private port: number;
  private sseTransports: Record<string, SSEServerTransport> = {};
  private streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

  constructor() {
    this.port = parseInt(process.env.PORT || process.env.MCP_SERVER_PORT || '8000');
    
    // Initialize Express app
    this.app = express();
    this.setupExpress();

    // Setup HTTP routes (MCP handlers are attached per-session in createMcpServer)
    this.setupRoutes();
  }

  /**
   * Create a GHL client and all tool instances from the given credentials.
   * Credentials come from request headers (multi-tenant) or fall back to
   * environment variables (single-tenant / backwards compatible).
   */
  private createToolsForClient(credentials: { apiKey: string; locationId: string; baseUrl: string }) {
    const { apiKey, locationId, baseUrl } = credentials;

    if (!apiKey) throw new Error('GHL API key is required. Pass it via the X-GHL-API-Key request header or the GHL_API_KEY environment variable.');
    if (!locationId) throw new Error('GHL Location ID is required. Pass it via the X-GHL-Location-Id request header or the GHL_LOCATION_ID environment variable.');

    const config: GHLConfig = {
      accessToken: apiKey,
      baseUrl: baseUrl || 'https://services.leadconnectorhq.com',
      version: '2021-07-28',
      locationId,
    };

    const ghlClient = new GHLApiClient(config);

    return {
      ghlClient,
      contactTools: new ContactTools(ghlClient),
      conversationTools: new ConversationTools(ghlClient),
      blogTools: new BlogTools(ghlClient),
      opportunityTools: new OpportunityTools(ghlClient),
      calendarTools: new CalendarTools(ghlClient),
      emailTools: new EmailTools(ghlClient),
      locationTools: new LocationTools(ghlClient),
      emailISVTools: new EmailISVTools(ghlClient),
      socialMediaTools: new SocialMediaTools(ghlClient),
      mediaTools: new MediaTools(ghlClient),
      objectTools: new ObjectTools(ghlClient),
      associationTools: new AssociationTools(ghlClient),
      customFieldV2Tools: new CustomFieldV2Tools(ghlClient),
      workflowTools: new WorkflowTools(ghlClient),
      surveyTools: new SurveyTools(ghlClient),
      storeTools: new StoreTools(ghlClient),
      productsTools: new ProductsTools(ghlClient),
    };
  }

  /**
   * Extract GHL credentials from request headers, falling back to env vars.
   * This enables multi-tenant usage: each Retell agent passes its own headers,
   * while single-tenant deployments continue working via env vars alone.
   */
  private extractCredentials(req: express.Request): { apiKey: string; locationId: string; baseUrl: string } {
    return {
      apiKey: (req.headers['x-ghl-api-key'] as string) || process.env.GHL_API_KEY || '',
      locationId: (req.headers['x-ghl-location-id'] as string) || process.env.GHL_LOCATION_ID || '',
      baseUrl: (req.headers['x-ghl-base-url'] as string) || process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
    };
  }

  /**
   * Create a fresh MCP Server instance with handlers attached.
   * Called once per transport session (the SDK's Server/Protocol class
   * only supports a single active transport connection at a time).
   * Accepts a per-session tools bundle so each client uses its own credentials.
   */
  private createMcpServer(tools: ReturnType<typeof this.createToolsForClient>): Server {
    const server = new Server(
      {
        name: 'ghl-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupMCPHandlers(server, tools);

    return server;
  }

  /**
   * Setup Express middleware and configuration
   */
  private setupExpress(): void {
    // Enable CORS for MCP clients (ChatGPT, Retell, Claude, etc.)
    this.app.use(cors({
      origin: true,
      methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'mcp-session-id'],
      exposedHeaders: ['mcp-session-id'],
      credentials: true
    }));

    // Parse JSON requests
    this.app.use(express.json());

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`[HTTP] ${req.method} ${req.path} - ${new Date().toISOString()}`);
      next();
    });
  }

  /**
   * Initialize GoHighLevel API client with configuration
   */
  /**
   * Setup MCP request handlers on a given Server instance.
   *
   * Each transport session gets its own Server instance (the SDK's Protocol
   * class only tracks a single active transport at a time), but all sessions
   * share the same underlying tool implementations and GHL client, so the
   * handler logic itself is identical across sessions.
   */
  private setupMCPHandlers(server: Server, tools: ReturnType<typeof this.createToolsForClient>): void {
    const {
      contactTools, conversationTools, blogTools, opportunityTools, calendarTools,
      emailTools, locationTools, emailISVTools, socialMediaTools, mediaTools,
      objectTools, associationTools, customFieldV2Tools, workflowTools,
      surveyTools, storeTools, productsTools
    } = tools;

    // Handle list tools requests
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.log('[GHL MCP HTTP] Listing available tools...');
      
      try {
        const contactToolDefinitions = contactTools.getToolDefinitions();
        const conversationToolDefinitions = conversationTools.getToolDefinitions();
        const blogToolDefinitions = blogTools.getToolDefinitions();
        const opportunityToolDefinitions = opportunityTools.getToolDefinitions();
        const calendarToolDefinitions = calendarTools.getToolDefinitions();
        const emailToolDefinitions = emailTools.getToolDefinitions();
        const locationToolDefinitions = locationTools.getToolDefinitions();
        const emailISVToolDefinitions = emailISVTools.getToolDefinitions();
        const socialMediaToolDefinitions = socialMediaTools.getTools();
        const mediaToolDefinitions = mediaTools.getToolDefinitions();
        const objectToolDefinitions = objectTools.getToolDefinitions();
        const associationToolDefinitions = associationTools.getTools();
        const customFieldV2ToolDefinitions = customFieldV2Tools.getTools();
        const workflowToolDefinitions = workflowTools.getTools();
        const surveyToolDefinitions = surveyTools.getTools();
        const storeToolDefinitions = storeTools.getTools();
        const productsToolDefinitions = productsTools.getTools();
        
        const allTools = [
          ...contactToolDefinitions,
          ...conversationToolDefinitions,
          ...blogToolDefinitions,
          ...opportunityToolDefinitions,
          ...calendarToolDefinitions,
          ...emailToolDefinitions,
          ...locationToolDefinitions,
          ...emailISVToolDefinitions,
          ...socialMediaToolDefinitions,
          ...mediaToolDefinitions,
          ...objectToolDefinitions,
          ...associationToolDefinitions,
          ...customFieldV2ToolDefinitions,
          ...workflowToolDefinitions,
          ...surveyToolDefinitions,
          ...storeToolDefinitions,
          ...productsToolDefinitions
        ];
        
        console.log(`[GHL MCP HTTP] Registered ${allTools.length} tools total`);
        
        return {
          tools: allTools
        };
      } catch (error) {
        console.error('[GHL MCP HTTP] Error listing tools:', error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list tools: ${error}`
        );
      }
    });

    // Handle tool execution requests
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      console.log(`[GHL MCP HTTP] Executing tool: ${name}`);

      try {
        let result: any;

        // Route to appropriate tool handler
        if (this.isContactTool(name)) {
          result = await contactTools.executeTool(name, args || {});
        } else if (this.isConversationTool(name)) {
          result = await conversationTools.executeTool(name, args || {});
        } else if (this.isBlogTool(name)) {
          result = await blogTools.executeTool(name, args || {});
        } else if (this.isOpportunityTool(name)) {
          result = await opportunityTools.executeTool(name, args || {});
        } else if (this.isCalendarTool(name)) {
          result = await calendarTools.executeTool(name, args || {});
        } else if (this.isEmailTool(name)) {
          result = await emailTools.executeTool(name, args || {});
        } else if (this.isLocationTool(name)) {
          result = await locationTools.executeTool(name, args || {});
        } else if (this.isEmailISVTool(name)) {
          result = await emailISVTools.executeTool(name, args || {});
        } else if (this.isSocialMediaTool(name)) {
          result = await socialMediaTools.executeTool(name, args || {});
        } else if (this.isMediaTool(name)) {
          result = await mediaTools.executeTool(name, args || {});
        } else if (this.isObjectTool(name)) {
          result = await objectTools.executeTool(name, args || {});
        } else if (this.isAssociationTool(name)) {
          result = await associationTools.executeAssociationTool(name, args || {});
        } else if (this.isCustomFieldV2Tool(name)) {
          result = await customFieldV2Tools.executeCustomFieldV2Tool(name, args || {});
        } else if (this.isWorkflowTool(name)) {
          result = await workflowTools.executeWorkflowTool(name, args || {});
        } else if (this.isSurveyTool(name)) {
          result = await surveyTools.executeSurveyTool(name, args || {});
        } else if (this.isStoreTool(name)) {
          result = await storeTools.executeStoreTool(name, args || {});
        } else if (this.isProductsTool(name)) {
          result = await productsTools.executeProductsTool(name, args || {});
        } else {
          throw new Error(`Unknown tool: ${name}`);
        }
        
        console.log(`[GHL MCP HTTP] Tool ${name} executed successfully`);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        console.error(`[GHL MCP HTTP] Error executing tool ${name}:`, error);
        
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error}`
        );
      }
    });
  }

  /**
   * Setup HTTP routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy',
        server: 'ghl-mcp-server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        tools: 215
      });
    });

    // MCP capabilities endpoint
    this.app.get('/capabilities', (req, res) => {
      res.json({
        capabilities: {
          tools: {},
        },
        server: {
          name: 'ghl-mcp-server',
          version: '1.0.0'
        }
      });
    });

    // Tools listing endpoint
    this.app.get('/tools', async (req, res) => {
      try {
        const tools = this.createToolsForClient(this.extractCredentials(req));
        const allTools = [
          ...tools.contactTools.getToolDefinitions(),
          ...tools.conversationTools.getToolDefinitions(),
          ...tools.blogTools.getToolDefinitions(),
          ...tools.opportunityTools.getToolDefinitions(),
          ...tools.calendarTools.getToolDefinitions(),
          ...tools.emailTools.getToolDefinitions(),
          ...tools.locationTools.getToolDefinitions(),
          ...tools.emailISVTools.getToolDefinitions(),
          ...tools.socialMediaTools.getTools(),
          ...tools.mediaTools.getToolDefinitions(),
          ...tools.objectTools.getToolDefinitions(),
          ...tools.associationTools.getTools(),
          ...tools.customFieldV2Tools.getTools(),
          ...tools.workflowTools.getTools(),
          ...tools.surveyTools.getTools(),
          ...tools.storeTools.getTools(),
          ...tools.productsTools.getTools(),
        ];
        res.json({ tools: allTools, count: allTools.length });
      } catch (error) {
        res.status(500).json({ error: 'Failed to list tools' });
      }
    });

    // MCP endpoint at /sse, supporting two transport protocols for backwards
    // compatibility with different clients:
    //
    //  1. Deprecated HTTP+SSE transport (protocol version 2024-11-05)
    //     - GET /sse opens the event stream and returns a sessionId via an
    //       "event: endpoint" message (?sessionId=... query string)
    //     - POST /sse?sessionId=... delivers a JSON-RPC message to that session
    //     Used by: ChatGPT, Claude Desktop (older configs)
    //
    //  2. Streamable HTTP transport (protocol version 2025-03-26)
    //     - POST /sse with no prior GET sends the "initialize" JSON-RPC call
    //       directly; the server assigns a session and returns it via the
    //       "Mcp-Session-Id" response header
    //     - Subsequent requests (GET/POST/DELETE) include that header
    //     Used by: Retell, and other modern MCP clients
    //
    // A previous version of this handler only implemented (1), and routed
    // both GET and POST to the same code path, which created a new dangling
    // stream on every POST instead of forwarding messages to the existing
    // transport. Clients using (2), like Retell, POST "initialize" with no
    // sessionId query param and no prior GET at all, so that version also
    // rejected them outright with a 400. This version detects which protocol
    // a given request is using and routes it to the matching transport.

    const handleStreamableRequest = async (req: express.Request, res: express.Response) => {
      const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;

      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionIdHeader && this.streamableTransports[sessionIdHeader]) {
          transport = this.streamableTransports[sessionIdHeader];
        } else if (!sessionIdHeader && req.method === 'POST' && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              console.log(`[GHL MCP HTTP] Streamable HTTP session initialized: ${newSessionId}`);
              this.streamableTransports[newSessionId] = transport;
            }
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              console.log(`[GHL MCP HTTP] Streamable HTTP session closed: ${sid}`);
              delete this.streamableTransports[sid];
            }
          };

          const server = this.createMcpServer(this.createToolsForClient(this.extractCredentials(req)));
          await server.connect(transport);
        } else {
          console.error(`[GHL MCP HTTP] Streamable HTTP request with missing/unknown session: ${sessionIdHeader || 'none'}`);
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('[GHL MCP HTTP] Error handling Streamable HTTP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    };

    this.app.get('/sse', async (req, res) => {
      // A request carrying an Mcp-Session-Id header (or referencing a known
      // Streamable HTTP session) is a Streamable HTTP client reopening its
      // notification stream, not a legacy SSE client starting a fresh one.
      const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;
      if (sessionIdHeader && this.streamableTransports[sessionIdHeader]) {
        await handleStreamableRequest(req, res);
        return;
      }

      console.log(`[GHL MCP HTTP] New legacy SSE stream request from: ${req.ip}`);

      try {
        const transport = new SSEServerTransport('/sse', res);
        this.sseTransports[transport.sessionId] = transport;

        transport.onclose = () => {
          console.log(`[GHL MCP HTTP] Legacy SSE stream closed for session: ${transport.sessionId}`);
          delete this.sseTransports[transport.sessionId];
        };

        const server = this.createMcpServer(this.createToolsForClient(this.extractCredentials(req)));
        await server.connect(transport);

        console.log(`[GHL MCP HTTP] Legacy SSE stream established for session: ${transport.sessionId}`);

        req.on('close', () => {
          delete this.sseTransports[transport.sessionId];
        });
      } catch (error) {
        console.error(`[GHL MCP HTTP] Legacy SSE stream error:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to establish SSE connection' });
        } else {
          res.end();
        }
      }
    });

    this.app.post('/sse', async (req, res) => {
      const querySessionId = (req.query.sessionId as string) || undefined;

      // A query-string sessionId identifies a legacy SSE client sending a
      // message to its already-open stream.
      if (querySessionId) {
        const transport = this.sseTransports[querySessionId];

        if (!transport) {
          console.error(`[GHL MCP HTTP] POST /sse for unknown legacy sessionId: ${querySessionId}`);
          res.status(404).json({ error: 'Unknown sessionId. The SSE stream may have closed; reconnect via GET /sse.' });
          return;
        }

        try {
          await transport.handlePostMessage(req, res, req.body);
        } catch (error) {
          console.error(`[GHL MCP HTTP] Error handling legacy POST message for session ${querySessionId}:`, error);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to process message' });
          }
        }
        return;
      }

      // No query-string sessionId: this is a Streamable HTTP client, either
      // initializing a brand new session or sending a follow-up request
      // identified by the Mcp-Session-Id header.
      await handleStreamableRequest(req, res);
    });

    this.app.delete('/sse', async (req, res) => {
      // Streamable HTTP clients may explicitly terminate their session.
      await handleStreamableRequest(req, res);
    });

    // Root endpoint with server info
    this.app.get('/', (req, res) => {
      res.json({
        name: 'GoHighLevel MCP Server',
        version: '1.0.0',
        status: 'running',
        endpoints: {
          health: '/health',
          capabilities: '/capabilities',
          tools: '/tools',
          sse: '/sse'
        },
        tools: 215,
        documentation: 'https://github.com/your-repo/ghl-mcp-server'
      });
    });
  }

  /**
  /**
   * Tool name validation helpers
   */
  private isContactTool(toolName: string): boolean {
    const contactToolNames = [
      // Basic Contact Management
      'create_contact', 'search_contacts', 'get_contact', 'update_contact',
      'add_contact_tags', 'remove_contact_tags', 'delete_contact',
      // Task Management
      'get_contact_tasks', 'create_contact_task', 'get_contact_task', 'update_contact_task',
      'delete_contact_task', 'update_task_completion',
      // Note Management
      'get_contact_notes', 'create_contact_note', 'get_contact_note', 'update_contact_note',
      'delete_contact_note',
      // Advanced Operations
      'upsert_contact', 'get_duplicate_contact', 'get_contacts_by_business', 'get_contact_appointments',
      // Bulk Operations
      'bulk_update_contact_tags', 'bulk_update_contact_business',
      // Followers Management
      'add_contact_followers', 'remove_contact_followers',
      // Campaign Management
      'add_contact_to_campaign', 'remove_contact_from_campaign', 'remove_contact_from_all_campaigns',
      // Workflow Management
      'add_contact_to_workflow', 'remove_contact_from_workflow'
    ];
    return contactToolNames.includes(toolName);
  }

  private isConversationTool(toolName: string): boolean {
    const conversationToolNames = [
      // Basic conversation operations
      'send_sms', 'send_email', 'search_conversations', 'get_conversation',
      'create_conversation', 'update_conversation', 'delete_conversation', 'get_recent_messages',
      // Message management
      'get_email_message', 'get_message', 'upload_message_attachments', 'update_message_status',
      // Manual message creation
      'add_inbound_message', 'add_outbound_call',
      // Call recordings & transcriptions
      'get_message_recording', 'get_message_transcription', 'download_transcription',
      // Scheduling management
      'cancel_scheduled_message', 'cancel_scheduled_email',
      // Live chat features
      'live_chat_typing'
    ];
    return conversationToolNames.includes(toolName);
  }

  private isBlogTool(toolName: string): boolean {
    const blogToolNames = [
      'create_blog_post', 'update_blog_post', 'get_blog_posts', 'get_blog_sites',
      'get_blog_authors', 'get_blog_categories', 'check_url_slug'
    ];
    return blogToolNames.includes(toolName);
  }

  private isOpportunityTool(toolName: string): boolean {
    const opportunityToolNames = [
      'search_opportunities', 'get_pipelines', 'get_opportunity', 'create_opportunity',
      'update_opportunity_status', 'delete_opportunity', 'update_opportunity', 
      'upsert_opportunity', 'add_opportunity_followers', 'remove_opportunity_followers'
    ];
    return opportunityToolNames.includes(toolName);
  }

  private isCalendarTool(toolName: string): boolean {
    const calendarToolNames = [
      // Calendar Groups Management
      'get_calendar_groups', 'create_calendar_group', 'validate_group_slug',
      'update_calendar_group', 'delete_calendar_group', 'disable_calendar_group',
      // Calendars
      'get_calendars', 'create_calendar', 'get_calendar', 'update_calendar', 'delete_calendar',
      // Events and Appointments
      'get_calendar_events', 'get_free_slots', 'create_appointment', 'get_appointment',
      'update_appointment', 'delete_appointment',
      // Appointment Notes
      'get_appointment_notes', 'create_appointment_note', 'update_appointment_note', 'delete_appointment_note',
      // Calendar Resources
      'get_calendar_resources', 'get_calendar_resource_by_id', 'update_calendar_resource', 'delete_calendar_resource',
      // Calendar Notifications
      'get_calendar_notifications', 'create_calendar_notification', 'update_calendar_notification', 'delete_calendar_notification',
      // Blocked Slots
      'create_block_slot', 'update_block_slot', 'get_blocked_slots', 'delete_blocked_slot'
    ];
    return calendarToolNames.includes(toolName);
  }

  private isEmailTool(toolName: string): boolean {
    const emailToolNames = [
      'get_email_campaigns', 'create_email_template', 'get_email_templates',
      'update_email_template', 'delete_email_template'
    ];
    return emailToolNames.includes(toolName);
  }

  private isLocationTool(toolName: string): boolean {
    const locationToolNames = [
      // Location Management
      'search_locations', 'get_location', 'create_location', 'update_location', 'delete_location',
      // Location Tags
      'get_location_tags', 'create_location_tag', 'get_location_tag', 'update_location_tag', 'delete_location_tag',
      // Location Tasks
      'search_location_tasks',
      // Custom Fields
      'get_location_custom_fields', 'create_location_custom_field', 'get_location_custom_field', 
      'update_location_custom_field', 'delete_location_custom_field',
      // Custom Values
      'get_location_custom_values', 'create_location_custom_value', 'get_location_custom_value',
      'update_location_custom_value', 'delete_location_custom_value',
      // Templates
      'get_location_templates', 'delete_location_template',
      // Timezones
      'get_timezones'
    ];
    return locationToolNames.includes(toolName);
  }

  private isEmailISVTool(toolName: string): boolean {
    const emailISVToolNames = [
      'verify_email'
    ];
    return emailISVToolNames.includes(toolName);
  }

  private isSocialMediaTool(toolName: string): boolean {
    const socialMediaToolNames = [
      // Post Management
      'search_social_posts', 'create_social_post', 'get_social_post', 'update_social_post',
      'delete_social_post', 'bulk_delete_social_posts',
      // Account Management
      'get_social_accounts', 'delete_social_account',
      // CSV Operations
      'upload_social_csv', 'get_csv_upload_status', 'set_csv_accounts',
      // Categories & Tags
      'get_social_categories', 'get_social_category', 'get_social_tags', 'get_social_tags_by_ids',
      // OAuth Integration
      'start_social_oauth', 'get_platform_accounts'
    ];
    return socialMediaToolNames.includes(toolName);
  }

  private isMediaTool(toolName: string): boolean {
    const mediaToolNames = [
      'get_media_files', 'upload_media_file', 'delete_media_file'
    ];
    return mediaToolNames.includes(toolName);
  }

  private isObjectTool(toolName: string): boolean {
    const objectToolNames = [
      'get_all_objects', 'create_object_schema', 'get_object_schema', 'update_object_schema',
      'create_object_record', 'get_object_record', 'update_object_record', 'delete_object_record',
      'search_object_records'
    ];
    return objectToolNames.includes(toolName);
  }

  private isAssociationTool(toolName: string): boolean {
    const associationToolNames = [
      'ghl_get_all_associations', 'ghl_create_association', 'ghl_get_association_by_id',
      'ghl_update_association', 'ghl_delete_association', 'ghl_get_association_by_key',
      'ghl_get_association_by_object_key', 'ghl_create_relation', 'ghl_get_relations_by_record',
      'ghl_delete_relation'
    ];
    return associationToolNames.includes(toolName);
  }

  private isCustomFieldV2Tool(toolName: string): boolean {
    const customFieldV2ToolNames = [
      'ghl_get_custom_field_by_id', 'ghl_create_custom_field', 'ghl_update_custom_field',
      'ghl_delete_custom_field', 'ghl_get_custom_fields_by_object_key', 'ghl_create_custom_field_folder',
      'ghl_update_custom_field_folder', 'ghl_delete_custom_field_folder'
    ];
    return customFieldV2ToolNames.includes(toolName);
  }

  private isWorkflowTool(toolName: string): boolean {
    const workflowToolNames = [
      'ghl_get_workflows'
    ];
    return workflowToolNames.includes(toolName);
  }

  private isSurveyTool(toolName: string): boolean {
    const surveyToolNames = [
      'ghl_get_surveys',
      'ghl_get_survey_submissions'
    ];
    return surveyToolNames.includes(toolName);
  }

  private isStoreTool(toolName: string): boolean {
    const storeToolNames = [
      'ghl_create_shipping_zone', 'ghl_list_shipping_zones', 'ghl_get_shipping_zone',
      'ghl_update_shipping_zone', 'ghl_delete_shipping_zone', 'ghl_get_available_shipping_rates',
      'ghl_create_shipping_rate', 'ghl_list_shipping_rates', 'ghl_get_shipping_rate',
      'ghl_update_shipping_rate', 'ghl_delete_shipping_rate', 'ghl_create_shipping_carrier',
      'ghl_list_shipping_carriers', 'ghl_get_shipping_carrier', 'ghl_update_shipping_carrier',
      'ghl_delete_shipping_carrier', 'ghl_create_store_setting', 'ghl_get_store_setting'
    ];
    return storeToolNames.includes(toolName);
  }

  private isProductsTool(toolName: string): boolean {
    const productsToolNames = [
      'ghl_create_product', 'ghl_list_products', 'ghl_get_product', 'ghl_update_product',
      'ghl_delete_product', 'ghl_bulk_update_products', 'ghl_create_price', 'ghl_list_prices',
      'ghl_get_price', 'ghl_update_price', 'ghl_delete_price', 'ghl_list_inventory',
      'ghl_update_inventory', 'ghl_get_product_store_stats', 'ghl_update_product_store',
      'ghl_create_product_collection', 'ghl_list_product_collections', 'ghl_get_product_collection',
      'ghl_update_product_collection', 'ghl_delete_product_collection', 'ghl_list_product_reviews',
      'ghl_get_reviews_count', 'ghl_update_product_review', 'ghl_delete_product_review',
      'ghl_bulk_update_product_reviews'
    ];
    return productsToolNames.includes(toolName);
  }

  /**
   * Test GHL API connection
  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    console.log('🚀 Starting GoHighLevel MCP HTTP Server (multi-tenant mode)...');
    console.log('=========================================');
    console.log('Credentials are read per-session from request headers:');
    console.log('  X-GHL-Api-Key, X-GHL-Location-Id, X-GHL-Base-Url');
    console.log('Falling back to env vars if headers are absent.');
    console.log('=========================================');
    
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log('✅ GoHighLevel MCP HTTP Server started successfully!');
      console.log(`🌐 Server running on: http://0.0.0.0:${this.port}`);
      console.log(`🔗 SSE Endpoint: http://0.0.0.0:${this.port}/sse`);
      console.log(`📋 Tools Available: 215`);
      console.log('=========================================');
    });
  }
}

/**
 * Handle graceful shutdown
 */
function setupGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    console.log(`\n[GHL MCP HTTP] Received ${signal}, shutting down gracefully...`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Setup graceful shutdown
    setupGracefulShutdown();
    
    // Create and start HTTP server
    const server = new GHLMCPHttpServer();
    await server.start();
    
  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
