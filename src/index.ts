import { type Plugin } from '@elizaos/core';

import { modelerEvaluator } from './evaluators/modeler.ts';

export const digitalTwinPlugin: Plugin = {
  name: 'digital-twin',
  description: 'Modeling the audience',
  evaluators: [
    modelerEvaluator
  ],
  /*
  providers: [
    // provider that drives filled out the character more...
  ],
  */
  //services: [],
}

export default digitalTwinPlugin;