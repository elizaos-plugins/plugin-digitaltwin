import {
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  type State,
  getEntityDetails,
  formatMessages,
  ModelType,
  composePromptFromState,
  asUUID,
  characterSchema,
} from '@elizaos/core';
import { v4 } from 'uuid';
import { parseXml } from '../utils.ts';
import { schemaToPrompt } from '../utils_zod.ts';

const COMPONENT_TYPE_CHARACTER = 'CHARACTER'

export async function askLlmObject(
  runtime: IAgentRuntime,
  ask: Object,
  requiredFields: string[],
  maxRetries = 3
) {
  //console.log('using askLlmObject')
  let responseContent: any | null = null;
  // Retry if missing required fields
  let retries = 0;

  function checkRequired(resp) {
    if (!resp) {
      console.log('No response')
      return false;
    }
    let hasAll = true;
    for (const f of requiredFields) {
      // allow nulls
      if (resp[f] === undefined) {
        console.log('resp is missing', f, resp[f], resp)
        hasAll = false;
        break;
      }
    }
    return hasAll;
  }
  if (!ask.system) {
    console.log('trader::utils:askLlmObject - Omitting system prompt')
  }

  let good = false;
  while (retries < maxRetries && !good) {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      ...ask, // prompt, system
      /*
      temperature: 0.2,
      maxTokens: 4096,
      object: true,
      */
    });

    // too coarse but the only place to see <think>
    console.log('trader::utils:askLlmObject - response', response);

    // we do not need the backtic stuff .replace('```json', '').replace('```', '')
    let cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '')
    responseContent = parseJSONObjectFromText(cleanResponse) as any;

    retries++;
    good = checkRequired(responseContent);
    if (!good) {
      logger.warn(
        '*** Missing required fields',
        responseContent,
        'needs',
        requiredFields,
        ', retrying... ***'
      );
    }
  }
  // can run null
  return responseContent;
}

export const modelerEvaluator: Evaluator = {
  name: 'MODEL_ENTITY',
  similes: [],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // maybe we run once every 25-32 messages?
    return true
  },
  description: 'Model audience into digital twin characters',
  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    console.log('digitalTwin:modeler')
/*
message {
  id: "93c62b4f-b9db-07a9-a39c-12f460a841bb",
  entityId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
  agentId: "479233fd-b0e7-0f50-9d88-d4c9ea5b0de0",
  roomId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
  content: {
    text: "lets chat",
    source: "telegram",
    channelType: "DM",
    inReplyTo: undefined,
  },
  metadata: {
    entityName: "Vector0",
    entityUserName: "VectorZer0",
    fromBot: false,
    fromId: 418984751,
    sourceId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
    type: "message",
  },
  createdAt: 1760566998000,
}
*/
    const { roomId } = message;
    //console.log('message', message)

    const uniqId = message?.metadata?.sourceId
    if (!uniqId) {
      runtime.logger.log('message has no identity')
      return
    }

    // get current modeled entity
    const entityId = message.metadata.sourceId
    let entity = await runtime.getEntityById(entityId);
    if (!entity) {
      const success = await runtime.createEntity({
        id: entityId,
        //names: [message.names],
        //metadata: entityMetadata,
        agentId: runtime.agentId,
      });
      entity = await runtime.getEntityById(entityId);
    }

    //const entities = await runtime.getEntitiesByIds([entityId])
    //const entity = entities[entityId]

    //console.log('entity', entity)
    /*
entity {
  id: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
  agentId: "479233fd-b0e7-0f50-9d88-d4c9ea5b0de0",
  createdAt: 1750790439000,
  names: [ "Vector0", "VectorZer0" ],
  metadata: {
    telegram: {
      name: "Vector0",
      userName: "VectorZer0",
    },
  },
  components: [
    {
      id: "0ba888b5-bfdc-06e0-a69c-bb1dfcaccc48",
      entityId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      agentId: "479233fd-b0e7-0f50-9d88-d4c9ea5b0de0",
      roomId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      worldId: "e0151a63-542b-0388-a2f0-86f87e1600ac",
      sourceEntityId: "479233fd-b0e7-0f50-9d88-d4c9ea5b0de0",
      type: "trust_profile",
      data: [Object ...],
      createdAt: 1757377065000,
    }, {
      id: "858d3281-cb48-4fc2-9d21-02d0cc13e0fa",
      entityId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      agentId: "479233fd-b0e7-0f50-9d88-d4c9ea5b0de0",
      roomId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      worldId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      sourceEntityId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      type: "component_user_v0",
      data: [Object ...],
      createdAt: 1754526490000,
    }
  ],
}
    */
    /*
    const conversationLength = runtime.getConversationLength(); // defaults to 32
    const hypos = await runtime.getMemories({
      tableName: 'hypotheses', // prefix this with neuro_
      //roomId,
      //count: conversationLength,
      unique: false,
    })
    const entitiesData = await getEntityDetails({ runtime, roomId })
    */
    //console.log('neuro:convo:handler - convos', convos)

    let characterComp = entity.components.find(c => c.type === COMPONENT_TYPE_CHARACTER)
    // ensure comp
    if (!characterComp) {
      const roomDetails = await runtime.getRoom(message.roomId);
      const res: boolean = await runtime.createComponent({
        id: v4() as UUID,
        agentId: runtime.agentId,
        worldId: roomDetails.worldId,
        roomId: message.roomId,
        sourceEntityId: message.entityId,
        entityId: entityId,
        type: COMPONENT_TYPE_CHARACTER,
        data: {
        },
        createdAt: Date.now(),
      });
      if (!res) {
        runtime.logger.warn('failed to create component for character, aborting modeling')
        return
      }
      // reget components
      entity = await runtime.getEntityById(entityId);
      characterComp = entity.components.find(c => c.type === COMPONENT_TYPE_CHARACTER)
    }
    /*
    characterComp {
      id: "336fd005-46fc-4e9d-8076-5fc20d2c291e",
      entityId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      agentId: "479233fd-b0e7-0f50-9d88-d4c9ea5b0de0",
      roomId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      worldId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      sourceEntityId: "1f3ce254-94a7-03fb-8b73-833c6e4542fb",
      type: "CHARACTER",
      data: {},
      createdAt: 1760567005000,
    }
    */
    console.log('characterComp', characterComp)
    // adjust this character accordingly...
    // describe current character
    // ask about interaction to propose changes
    const characterDescription = schemaToPrompt(characterSchema)
    const template = `
<task>Review existing character file for user and recent conversation and see if we need to make any updates</task>

<character_structure>
${characterDescription}
</character_structure>

<character>
{}
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
    </update>
    <!-- Add more updates as needed -->
  </updates>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>`
    console.log('template', template)
    const prompt = composePromptFromState({
      state,
      template,
    });

    const response = await askLlmObject(runtime, {
     prompt,
    }, ['updates'])

    console.log('modeler response', response)

    // make changes
  },
  examples: [],
}
