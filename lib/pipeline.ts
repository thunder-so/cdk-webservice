import { Construct } from 'constructs';
import { CfnOutput, Duration, RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { PipelineProject, BuildSpec, LinuxArmBuildImage, LinuxBuildImage, ComputeType, BuildEnvironmentVariableType } from 'aws-cdk-lib/aws-codebuild';
import { Pipeline, Artifact, PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import { GitHubSourceAction, GitHubTrigger, CodeBuildAction, CodeBuildActionType } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { FargateService, TaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { WebServiceProps } from '../stack/WebServiceProps';

export interface WebServicePipelineProps extends WebServiceProps {
  cpu: number,
  memory: number,
  clusterName: string;
  fargateService: FargateService;
  taskDefinition: TaskDefinition;
}

export class PipelineConstruct extends Construct {
  private resourceIdPrefix: string;
  public readonly ecrRepository: Repository;
  public readonly codeBuildProject: PipelineProject;
  public readonly codePipeline: Pipeline;
  public readonly deployProject: PipelineProject;

  constructor(scope: Construct, id: string, props: WebServicePipelineProps) {
    super(scope, id);

    this.resourceIdPrefix = `${props.application}-${props.service}-${props.environment}`.substring(0, 42);

    this.ecrRepository = this.createEcrRepository(props);
    this.codeBuildProject = this.createBuildProject(props);

    this.deployProject = this.createDeployProject(props);

    this.codePipeline = this.createPipeline(props);

    // Output pipeline name
    new CfnOutput(this, 'WebServicePipelineName', {
      value: this.codePipeline.pipelineName,
      description: 'The name of the ECS Fargate deployment pipeline',
      exportName: `${this.resourceIdPrefix}-WebServicePipelineName`,
    });
  };

  /**
    * Creates an Amazon ECR repository for storing Docker images.
    * 
    * @private
    * @param {WebServicePipelineProps} props - The pipeline configuration properties.
    * @returns {Repository} The created ECR repository.
    */
  private createEcrRepository(props: WebServicePipelineProps): Repository {
    const repo = new Repository(this, 'ServiceEcrRepo', {
      repositoryName: `${this.resourceIdPrefix}-repo`,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Grant ECS task execution role permissions to pull from ECR
    props.taskDefinition?.executionRole?.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ],
        resources: [repo.repositoryArn], 
      })
    );

    return repo;
  };

  /**
    * Creates a CodeBuild project for building and pushing Docker images to ECR.
    * 
    * @private
    * @param {WebServicePipelineProps} props - The pipeline configuration properties.
    * @returns {PipelineProject} The created CodeBuild project.
    */
  private createBuildProject(props: WebServicePipelineProps): PipelineProject {
    // BuildSpec for Docker build & push using image digest and date-based tag
    const buildSpec = BuildSpec.fromObject({
      version: '0.2',
      phases: {
        pre_build: {
          commands: [
            'export IMAGE_TAG=$(date +%Y%m%d%H%M%S)',
            'aws --version',
            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPO',
          ],
        },
        build: {
          commands: [
            `docker build -t $ECR_REPO:$IMAGE_TAG -f ${props.serviceProps?.dockerFile || 'Dockerfile'} .`,
            'docker push $ECR_REPO:$IMAGE_TAG',
            'export IMAGE_DIGEST=$(docker inspect --format="{{index .RepoDigests 0}}" $ECR_REPO:$IMAGE_TAG | cut -d"@" -f2)',
          ],
        },
        post_build: {
          commands: [
            'export IMAGE_URI=$ECR_REPO@$IMAGE_DIGEST',
            'echo $IMAGE_URI > imageUri.txt',
            'echo $IMAGE_TAG > imageTag.txt',
            'echo $IMAGE_DIGEST > imageDigest.txt',
          ],
        },
      },
      artifacts: {
        files: [
          'imageUri.txt',
          'imageTag.txt',
          'imageDigest.txt',
        ],
      },
    });

    // Build environment variables
    const buildEnvironmentVariables: Record<string, any> = {
      ECR_REPO: { value: this.ecrRepository.repositoryUri },
      ...(props.buildProps?.environment
        ? Object.entries(Object.assign({}, ...(props.buildProps.environment))).reduce(
            (acc, [key, value]) => ({ ...acc, [key]: { value, type: BuildEnvironmentVariableType.PLAINTEXT } }),
            {}
          )
        : {}),
      ...(props.buildProps?.secrets
        ? Object.fromEntries(
            props.buildProps.secrets.map(({ key, resource }) => [
              key,
              { value: resource, type: BuildEnvironmentVariableType.PARAMETER_STORE },
            ])
          )
        : {}),
    };

    // CodeBuild project for Docker build & push
    const project = new PipelineProject(this, 'ServiceDockerBuild', {
      projectName: `${this.resourceIdPrefix}-docker-build`,
      buildSpec,
      environment: {
        buildImage: LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: ComputeType.SMALL,
        privileged: true,
      },
      environmentVariables: buildEnvironmentVariables,
      timeout: Duration.minutes(20),
    });

    // Grant CodeBuild permissions to push to ECR
    this.ecrRepository.grantPullPush(project);

    // Allow CodeBuild to get secrets if needed
    project.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: ["*"],
      })
    );

    return project;
  };

  /**
   * 
   */
  private createDeployProject(props: WebServicePipelineProps): PipelineProject {
    // Deploy project: update ECS service with new image
    // Deploy project: update ECS service by registering a new task definition revision with the new image digest
    const deployProject = new PipelineProject(this, 'EcsDeployProject', {
      projectName: `${this.resourceIdPrefix}-ecs-deploy`,
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "Starting ECS deployment..."',
              'IMAGE_URI=$(cat imageUri.txt)',
              'IMAGE_TAG=$(cat imageTag.txt)',
              'IMAGE_DIGEST=$(cat imageDigest.txt)',
              'echo "Deploying image: $IMAGE_URI (tag: $IMAGE_TAG, digest: $IMAGE_DIGEST)"',
              // Generate taskdef.json
              [
                'cat <<EOF > taskdef.json',
                '{',
                '  "family": "' + props.taskDefinition.family + '",',
                '  "networkMode": "' + props.taskDefinition.networkMode + '",',
                '  "containerDefinitions": [',
                '    {',
                '      "name": "' + props.taskDefinition.defaultContainer?.containerName + '",',
                '      "image": "' + '$IMAGE_URI' + '",',
                '      "essential": true,',
                '      "portMappings": [',
                '        {',
                '          "containerPort": ' + props.taskDefinition.defaultContainer?.containerPort + ',',
                '          "protocol": "tcp"',
                '        }',
                '      ],',
                // Environment variables
                ...(props.serviceProps?.variables && props.serviceProps.variables.length > 0 ? [
                  '  "environment": [',
                  ...props.serviceProps.variables.flatMap(envObj => 
                    Object.entries(envObj).map(([key, value], index, array) => 
                      `    { "name": "${key}", "value": "${value}" }${index < array.length - 1 ? ',' : ''}`
                    )
                  ),
                  '  ],',
                ] : []),
                // Secrets
                ...(props.serviceProps?.secrets && props.serviceProps.secrets.length > 0 ? [
                  '  "secrets": [',
                  ...props.serviceProps.secrets.map((secret, index, array) => 
                    `    { "name": "${secret.key}", "valueFrom": "${secret.resource}" }${index < array.length - 1 ? ',' : ''}`
                  ),
                  '  ],',
                ] : []),
                // HEALTH CHECK 
                '      "healthCheck": {',
                '        "command": [',
                '          "CMD-SHELL",',
                '          "nc -z localhost ' + (props.serviceProps?.port || 3000) + ' || exit 1"',
                '        ],',
                '        "interval": 15,',
                '        "timeout": 5,',
                '        "retries": 3,',
                '        "startPeriod": 60',
                '      },',
                // LOG CONFIGURATION
                '      "logConfiguration": {',
                '        "logDriver": "awslogs",',
                '        "options": {',
                '          "awslogs-group": "/webservice/' + this.resourceIdPrefix + '-logs",',
                '          "awslogs-region": "$AWS_DEFAULT_REGION",',
                '          "awslogs-stream-prefix": "web"',
                '        }',
                '      }',
                '    }',
                '  ],',
                '  "requiresCompatibilities": ["FARGATE"],',
                '  "cpu": "' + props.cpu + '",',
                '  "memory": "' + props.memory + '",',
                '  "executionRoleArn": "' + props.taskDefinition.executionRole?.roleArn + '",',
                '  "taskRoleArn": "' + props.taskDefinition.taskRole?.roleArn + '"',
                '}',
                'EOF',
              ].join('\n'),
            ],
          },
          build: {
            commands: [
              // Register new task definition revision from taskdef.json
              'NEW_TASK_DEF_ARN=$(aws ecs register-task-definition --cli-input-json file://taskdef.json --region $AWS_DEFAULT_REGION --query "taskDefinition.taskDefinitionArn" --output text)',
              'echo "New task definition: $NEW_TASK_DEF_ARN"',
              // Update ECS service to use the new task definition
              'aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --task-definition $NEW_TASK_DEF_ARN --force-new-deployment --region $AWS_DEFAULT_REGION',
              'aws ecs wait services-stable --cluster $ECS_CLUSTER --services $ECS_SERVICE --region $AWS_DEFAULT_REGION',
              'echo "ECS service deployed successfully"',
            ],
          },
        },
      }),
      environment: {
        buildImage: LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: ComputeType.SMALL,
        privileged: true,
      },
      environmentVariables: {
        ECS_CLUSTER: { value: props.clusterName || '' },
        ECS_SERVICE: { value: props.fargateService.serviceName || '' },
        ECS_TASKDEF: { value: props.taskDefinition.taskDefinitionArn || '' },
      },
      timeout: Duration.minutes(10),
    });

    // Allow deploy project to update ECS service and task definition
    deployProject.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ecs:UpdateService',
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'ecs:RegisterTaskDefinition',
        ],
        resources: ['*'], // You can scope this down if you want
      })
    );

    // Allow deploy project to pass roles (for task definition update)
    deployProject.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: ['*'],
      })
    );

    return deployProject;
  }

  /**
    * Creates a CodePipeline pipeline with source, build, and deploy stages.
    * 
    * @private
    * @param {WebServicePipelineProps} props - The pipeline configuration properties.
    * @returns {Pipeline} The created CodePipeline instance.
    */
  private createPipeline(props: WebServicePipelineProps): Pipeline {
    // Artifacts
    const sourceOutput = new Artifact('SourceOutput');
    const buildOutput = new Artifact('BuildOutput');

    // Pipeline
    return new Pipeline(this, 'WebServicePipeline', {
      pipelineName: `${this.resourceIdPrefix}-pipeline`,
      pipelineType: PipelineType.V2,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new GitHubSourceAction({
              actionName: 'GithubSourceAction',
              owner: props.sourceProps?.owner!,
              repo: props.sourceProps?.repo!,
              branch: props.sourceProps?.branchOrRef || 'main',
              oauthToken: SecretValue.secretsManager(props.accessTokenSecretArn!),
              output: sourceOutput,
              trigger: GitHubTrigger.WEBHOOK,
            })
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new CodeBuildAction({
              actionName: 'BuildAction',
              project: this.codeBuildProject,
              input: sourceOutput,
              outputs: [buildOutput],
              type: CodeBuildActionType.BUILD,
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new CodeBuildAction({
              actionName: 'DeployAction',
              project: this.deployProject,
              input: buildOutput,
            }),
          ],
        },
      ],
    });
  };
}