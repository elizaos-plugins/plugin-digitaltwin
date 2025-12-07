import {
  type Component,
  type Evaluator,
  formatMessages,
  getEntityDetails,
  type IAgentRuntime,
  type Memory,
  type MemoryMetadata,
  ModelType,
  type State,
  asUUID,
  composePromptFromState,
  characterSchema,
  stringToUuid
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import JSON5 from 'json5';
import { parseXml } from '../utils.ts';
import { schemaToPrompt } from '../utils_zod.ts';

const COMPONENT_TYPE_CHARACTER = 'CHARACTER';
const LOG_SCOPE = 'digitalTwin:modeler';

type AskLlmObjectXmlParams = {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
};

type CharacterUpdate = {
  field?: string;
  reason?: string;
  confidence?: string | number;
  weight?: string | number;
  new?: string;
  old?: string;
  difference?: string;
};

type XmlResponse = {
  updates?: {
    update?: CharacterUpdate | CharacterUpdate[];
  };
  userResponse?: string;
  userResponseReason?: string;
  userResponseConfidence?: string | number;
  userResponseMissingInfo?: string;
};

type CharacterMetadata = Record<string, unknown> & {
  id?: string;
  name?: string;
};

type MessageMetadataWithEntity = MemoryMetadata & {
  entityName?: string;
  entityUserName?: string;
};

function asCharacterMetadata(data: unknown): CharacterMetadata {
  if (data && typeof data === 'object') {
    return data as CharacterMetadata;
  }
  return {};
}

function isMessageMetadataWithEntity(
  metadata: MemoryMetadata | undefined
): metadata is MessageMetadataWithEntity {
  if (!metadata || typeof metadata !== 'object') return false;
  const candidate = metadata as MessageMetadataWithEntity;
  return typeof candidate.entityName === 'string' || typeof candidate.entityUserName === 'string';
}

export async function askLlmObjectXml(
  runtime: IAgentRuntime,
  ask: AskLlmObjectXmlParams,
  requiredFields: string[],
  maxRetries = 3
): Promise<XmlResponse | null> {
  let responseContent: XmlResponse | null = null;
  let retries = 0;

  const checkRequired = (resp: XmlResponse | null): boolean => {
    if (!resp) {
      runtime.logger.warn({ scope: LOG_SCOPE }, 'askLlmObjectXml received empty response');
      return false;
    }
    return requiredFields.every((field) => (resp as Record<string, unknown>)[field] !== undefined);
  };

  if (!ask.system) {
    runtime.logger.debug({ scope: LOG_SCOPE }, 'askLlmObjectXml omitting system prompt');
  }

  let satisfied = false;
  while (retries < maxRetries && !satisfied) {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      ...ask, // prompt, system
      temperature: 0.2,
      maxTokens: 16384, // Increased to prevent XML truncation
    });

    runtime.logger.debug({ scope: LOG_SCOPE, response }, 'askLlmObjectXml raw response');

    const cleanResponse =
      typeof response === 'string'
        ? response.replace(/<think>[\s\S]*?<\/think>/g, '')
        : '';

    retries++;
    responseContent = parseXml(cleanResponse) as XmlResponse | null;

    satisfied = checkRequired(responseContent);
    if (!satisfied) {
      runtime.logger.warn(
        {
          scope: LOG_SCOPE,
          response: responseContent,
          requiredFields,
        },
        'askLlmObjectXml missing required fields'
      );
    }
  }

  return responseContent;
}

export const modelerEvaluator: Evaluator = {
  name: 'MODEL_ENTITY',
  similes: [],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    runtime.logger.debug(
      {
        scope: LOG_SCOPE,
        entityId: message.entityId,
        roomId: message.roomId,
        metadata: message.metadata,
      },
      'validate'
    );
    return true;
  },
  description: 'Model audience into digital twin characters',
  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const metadata = message.metadata;
    if (!metadata || !isMessageMetadataWithEntity(metadata)) {
      runtime.logger.warn(
        {
          scope: LOG_SCOPE,
          metadata,
          messageId: message.id,
        },
        'message has no entity metadata'
      );
      return;
    }

    const entityId = metadata.sourceId;
    if (!entityId) {
      runtime.logger.warn(
        {
          scope: LOG_SCOPE,
          metadata,
          messageId: message.id,
        },
        'message metadata missing sourceId'
      );
      return;
    }

    const modelTarget = metadata.entityName ?? metadata.entityUserName ?? 'Unknown User';
    runtime.logger.debug(
      {
        scope: LOG_SCOPE,
        modelTarget,
        entityId,
      },
      'modeling entity'
    );

    const { roomId } = message;

    let entity = await runtime.getEntityById(entityId);
    if (!entity) {
      const created = await runtime.createEntity({
        id: entityId,
        names: [modelTarget],
        metadata: {},
        agentId: runtime.agentId,
      });
      if (!created) {
        runtime.logger.error(
          {
            scope: LOG_SCOPE,
            entityId,
          },
          'failed to create entity'
        );
        return;
      }
      entity = await runtime.getEntityById(entityId);
      if (!entity) {
        runtime.logger.error(
          {
            scope: LOG_SCOPE,
            entityId,
          },
          'unable to fetch entity after creation'
        );
        return;
      }
    }

    const formattedName = entity.names[0] ?? modelTarget;
    if (formattedName !== modelTarget) {
      runtime.logger.debug(
        {
          scope: LOG_SCOPE,
          formattedName,
          modelTarget,
        },
        'entity name mismatch'
      );
    }

    let characterComp: Component | undefined =
      entity.components?.find((component) => component.type === COMPONENT_TYPE_CHARACTER);

    if (!characterComp) {
      const roomDetails = await runtime.getRoom(message.roomId);
      if (!roomDetails?.worldId) {
        runtime.logger.warn(
          {
            scope: LOG_SCOPE,
            roomId: message.roomId,
          },
          'missing room details'
        );
        return;
      }

      const created = await runtime.createComponent({
        id: asUUID(uuidv4()),
        agentId: runtime.agentId,
        worldId: roomDetails.worldId,
        roomId: message.roomId,
        sourceEntityId: message.entityId,
        entityId,
        type: COMPONENT_TYPE_CHARACTER,
        data: {},
        createdAt: Date.now(),
      });
      if (!created) {
        runtime.logger.warn(
          {
            scope: LOG_SCOPE,
            entityId,
            roomId: message.roomId,
          },
          'failed to create character component'
        );
        return;
      }
      entity = await runtime.getEntityById(entityId);
      characterComp = entity?.components?.find(
        (component) => component.type === COMPONENT_TYPE_CHARACTER
      );
      if (!characterComp) {
        runtime.logger.error(
          {
            scope: LOG_SCOPE,
            entityId,
          },
          'unable to fetch character component after creation'
        );
        return;
      }
    }

    const character = asCharacterMetadata(characterComp.data);

    const activeState: State =
      state ?? (await runtime.composeState(message, ['RECENT_MESSAGES', 'RECENT_MEMORIES']));

    const conversationLength = runtime.getConversationLength();
    const entitiesData = await getEntityDetails({ runtime, roomId });
    const recentMessagesData = await runtime.getMemories({
      tableName: 'messages',
      roomId: message.roomId,
      count: conversationLength,
      unique: false,
    });

    const dialogueMessages = recentMessagesData.filter(
      (msg) => !(msg.content?.type === 'action_result' && msg.metadata?.type === 'action_result')
    );
    const formattedRecentMessages = await formatMessages({
      messages: dialogueMessages,
      entities: entitiesData,
    });

    const characterDescription = schemaToPrompt(characterSchema);
    const template = `
<task>Review existing character file for ${modelTarget} with recent conversation and see if we need to make any updates</task>

<messages>
${formattedRecentMessages}
</messages>

<character_structure>
${characterDescription}
</character_structure>

<instructions>
- You are {{agentName}}, we are managing a character for ${modelTarget} in the messages
- Don't say ${modelTarget} in the new value, it's already assumed
- Be economical but useful, high utility for LLM prompts to utilize when either estimating what this user would say OR how another character would interact with this character (the goal being to improve interactions between the two)
- system and message examples are important ensure we have data for them
</instructions>

<character>
${JSON.stringify(character, null, 2)}
</character>

<output>
Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
  <updates>
    <!-- Ok to return none -->
    <update>
      <field>address or name of fields you want to change</field>
      <reason>Your thought here</reason>
      <confidence>0-100 of how confidence you are about this change</confidence>
      <weight>0-100 how important this change is to capture this users personality</weight>
      <new>new value</new>
      <old>old value</old>
      <difference>Explains whats changed in the new value from the old value</difference>
    </update>
    <!-- Add more updates as needed -->
  </updates>
  <userResponse>Based on updated character data, what do we estimate ${modelTarget} will respond to what {{agentName}} said last?</userResponse>
  <userResponseReason>Your thought why</userResponseReason>
  <userResponseConfidence>0-100 of how confidence you are about this estimation</userResponseConfidence>
  <userResponseMissingInfo>What would you really like to know to tighten up this guess?</userResponseMissingInfo>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>`;
    runtime.logger.debug({ scope: LOG_SCOPE }, 'prompt template created');
    const prompt = composePromptFromState({
      state: activeState,
      template,
    });

    const response = await askLlmObjectXml(runtime, {
      prompt,
    }, ['updates'])
    if (!response?.updates?.update) {
      runtime.logger.warn(
        {
          scope: LOG_SCOPE,
          response,
        },
        'missing updates in LLM response'
      );
      return;
    }

    const applyUpdate = (update: CharacterUpdate) => {
      const field = update.field;
      if (!field) {
        runtime.logger.debug({ scope: LOG_SCOPE, update }, 'update missing field');
        return;
      }

      const currentValue = character[field];
      const expectedOld = update.old;
      if (expectedOld !== undefined && expectedOld !== currentValue) {
        runtime.logger.debug(
          {
            scope: LOG_SCOPE,
            field,
            expectedOld,
            currentValue,
          },
          'update old value mismatch'
        );
      }

      const next = update.new;
      if (typeof next !== 'string') {
        runtime.logger.debug(
          {
            scope: LOG_SCOPE,
            field,
            next,
          },
          'update new value not string'
        );
        return;
      }

      let parsedValue: unknown = next;
      const trimmed = next.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsedValue = JSON5.parse(next);
        } catch (error) {
          runtime.logger.debug(
            {
              scope: LOG_SCOPE,
              field,
              error,
            },
            'failed to parse JSON-like value'
          );
        }
      }

      character[field] = parsedValue;
    };

    const updates = response.updates.update;
    if (Array.isArray(updates)) {
      for (const update of updates) {
        applyUpdate(update);
      }
    } else {
      applyUpdate(updates);
    }

    character.name = modelTarget;
    if (typeof character.name === 'string' && character.name.length > 0) {
      try {
        character.id = stringToUuid(character.name);
      } catch (error) {
        runtime.logger.warn(
          {
            scope: LOG_SCOPE,
            name: character.name,
            error,
          },
          'failed to compute character id'
        );
      }
    }

    runtime.logger.debug({ scope: LOG_SCOPE, character }, 'updated character');

    await runtime.updateComponent({
      id: characterComp.id,
      entityId: characterComp.entityId,
      agentId: characterComp.agentId,
      roomId: characterComp.roomId,
      worldId: characterComp.worldId,
      sourceEntityId: characterComp.sourceEntityId,
      type: characterComp.type,
      createdAt: characterComp.createdAt,
      data: character,
    });
  },
  examples: [],
}
