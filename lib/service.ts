import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Cluster, ContainerImage, FargateService, FargateTaskDefinition, LogDriver, Protocol, Secret, TaskDefinition, Compatibility, CpuArchitecture } from 'aws-cdk-lib/aws-ecs';
import { Vpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ListenerAction, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { WebServiceProps } from '../stack/WebServiceProps';
import { Secret as SecretsManagerSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';

export class ServiceConstruct extends Construct {
  public readonly loadBalancerDnsName: string;

  constructor(scope: Construct, id: string, props: WebServiceProps) {
    super(scope, id);

    // Set the resource prefix
    const resourceIdPrefix = `${props.application}-${props.service}-${props.environment}`.substring(0, 42);

    // VPC
    const vpc = new Vpc(this, 'Vpc', {
      vpcName: `${resourceIdPrefix}-vpc`,
      maxAzs: 2,
      subnetConfiguration: [
          { name: 'public', subnetType: SubnetType.PUBLIC }
      ]
    });

    // ECS Cluster
    const cluster = new Cluster(this, 'Cluster', { 
      clusterName: `${resourceIdPrefix}-cluster`,
      vpc: vpc
    });

    // Log group for container logs
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `${resourceIdPrefix}-logs`,
      retention: RetentionDays.ONE_WEEK
    });

    // Task Definition
    // const taskDef = new FargateTaskDefinition(this, 'Task', {
    //   cpu: props.serviceProps?.cpu ?? 256,
    //   memoryLimitMiB: props.serviceProps?.memorySize ?? 512,
    // });
    const taskDef = new TaskDefinition(this, 'Task', {
      compatibility: Compatibility.FARGATE,
      cpu: `${props.serviceProps?.cpu ?? 256}`,
      memoryMiB: `${props.serviceProps?.memorySize ?? 512}`,
      runtimePlatform: {
        cpuArchitecture: props.serviceProps?.architecture ?? CpuArchitecture.ARM64,
      },
    });

    // Container
    const container = taskDef.addContainer('Container', {
      containerName: `${props.service}-container`,
      // image: ContainerImage.fromAsset(props.rootDir ?? '.'),
      image: ContainerImage.fromAsset(props.rootDir ?? '.', {
        file: props.serviceProps?.dockerFile,
        buildArgs: props.serviceProps?.dockerBuildArgs
          ? Object.fromEntries(
              props.serviceProps.dockerBuildArgs.map(arg => {
                const [key, value] = arg.split('=');
                return [key, value];
              })
            )
          : undefined,
      }),
      logging: LogDriver.awsLogs({ logGroup, streamPrefix: 'web' }),
      environment: props.serviceProps?.variables?.reduce((acc, obj) => ({ ...acc, ...obj }), {}) ?? {},
      secrets: props.serviceProps?.secrets
        ? Object.fromEntries(
            props.serviceProps.secrets.map(s => [
              s.key,
              Secret.fromSecretsManager(
                SecretsManagerSecret.fromSecretAttributes(this, `${s.key}Secret`, {
                  secretCompleteArn: s.resource
                })
              )
            ])
          ) as { [key: string]: Secret }
        : undefined,
    });

    container.addPortMappings({ containerPort: props.serviceProps?.port || 3000, protocol: Protocol.TCP });

    // Fargate Service
    const service = new FargateService(this, 'FargateService', {
      serviceName: `${resourceIdPrefix}-service`,
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.serviceProps?.desiredCount ?? 1,
      minHealthyPercent: 50,
      assignPublicIp: true,
    });

    // Application Load Balancer
    const lb = new ApplicationLoadBalancer(this, 'ALB', {
      loadBalancerName: resourceIdPrefix, // produces clean url
      vpc,
      internetFacing: true,
    });

    // Add HTTP listener (always)
    const listener = lb.addListener('Listener', {
      port: 80,
      open: true,
      protocol: ApplicationProtocol.HTTP,
    });

    // Add HTTPS listener if domain and certificate are provided
    let httpsListener;
    if (props.domain && props.hostedZoneId && props.regionalCertificateArn) {
      const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domain.split('.').slice(1).join('.'),
      });
      const certificate = Certificate.fromCertificateArn(this, 'Certificate', props.regionalCertificateArn);

      httpsListener = lb.addListener('HttpsListener', {
        port: 443,
        open: true,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [certificate],
      });

      httpsListener.addTargets('ECS', {
        port: props.serviceProps?.port || 3000,
        targets: [service],
        healthCheck: { path: '/' },
        protocol: ApplicationProtocol.HTTP,
        targetGroupName: 'WebServiceTG',
      });

      // Redirect HTTP to HTTPS
      listener.addAction('HTTPRedirect', {
        action: ListenerAction.redirect({ protocol: 'HTTPS', port: '443' }),
      });

      // Route53 A record for custom domain
      new ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: props.domain,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(lb)),
      });
    } else {
      // HTTP targets if no domain/cert
      listener.addTargets('ECS', {
        port: 80,
        targets: [service],
        healthCheck: { path: '/' },
        protocol: ApplicationProtocol.HTTP,
        targetGroupName: 'WebServiceTG',
      });
    }

    this.loadBalancerDnsName = lb.loadBalancerDnsName;

    new CfnOutput(this, 'LoadBalancerDNS', {
      value: this.loadBalancerDnsName,
      description: 'The DNS name of the load balancer',
    });
  }
}