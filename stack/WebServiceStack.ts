import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WebServiceProps } from './WebServiceProps';
import { ServiceConstruct, PipelineConstruct, EventsConstruct } from '../lib'

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

    // Set the default CPU and memory in MiB and pass them to constructs
    const cpu = props.serviceProps?.cpu ?? 256;
    const memoryMiB = props.serviceProps?.memorySize ?? 512;

    // Create the service construct
    const service = new ServiceConstruct(this, 'Service', {
      ...props,
      cpu: cpu,
      memory: memoryMiB,
    });

    /**
     * Pipeline enabled and GitHub access token provided
     * 
     */ 
    if (props?.accessTokenSecretArn) {
      // check for sourceProps
      if (!props.sourceProps?.owner || !props.sourceProps?.repo || !props.sourceProps?.branchOrRef) {
        throw new Error('Missing sourceProps: Github owner, repo and branch/ref required.');
      }

      const pipeline = new PipelineConstruct(this, 'Pipeline', {
        ...props,
        cpu: cpu,
        memory: memoryMiB,
        clusterName: service.clusterName,
        fargateService: service.fargateService,
        taskDefinition: service.taskDefinition,
      });

      // Pipeline events
      if (props.eventTarget) {
        new EventsConstruct(this, 'PipelineEvents', {
          ...props,
          codePipeline: pipeline.codePipeline,
        });
      }
    }; // end if
  }
}