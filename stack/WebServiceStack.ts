import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WebServiceProps } from './WebServiceProps';
import { ServiceConstruct } from '../lib'

export class WebServiceStack extends Stack {

  constructor(scope: Construct, id: string, props: WebServiceProps) {
    super(scope, id, props);

    // Check mandatory properties
    if (!props?.env) {
      throw new Error('Must provide AWS account and region.');
    }
    if (!props.application || !props.environment || !props.service) {
      throw new Error('Mandatory stack properties missing.');
    }

    // Create the service construct
    new ServiceConstruct(this, 'Service', props);
  }
}