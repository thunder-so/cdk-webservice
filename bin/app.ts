import { App } from "aws-cdk-lib";
import { WebServiceStack, type WebServiceProps } from '../';

const app = new App();

const metadata: WebServiceProps = app.node.tryGetContext('metadata');

if (!metadata) {
  throw new Error('Context metadata missing!');
}

new WebServiceStack(app, `${metadata.application}-${metadata.service}-${metadata.environment}-stack`, metadata);

app.synth();
