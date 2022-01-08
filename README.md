# ECS Cross Region Deploy:
A Simple JavaScript Lamda to register a new ECS task in another region and deregister the old one.

## Use Case:
Predominantly using Cape Town region (af-south-1), where _CodePipeline_ is not available. 
I had to figure out a way to deploy from Ireland (eu-west-1) to Cape Town. 

Running CodePipeline in Ireland with the last step triggering a lamda to deploy register a new _ECS_ task 
and deregister the old one.

## Prerequisites:
1. Various IAM roles and permissions.
2. UserParameters for the Lambda.

## CodePipeline IAM Role
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "codepipeline.amazonaws.com"
      },
      "Effect": "Allow"
    }
  ]
}
```
## CodePipeline IAM Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction"
      ],
      "Resource": "*"
    }
  ]
}
```
## Terraform Deploy Stage. 
Note here is the UserParameters
```
dynamic "stage" {
    content {
      name = "Deploye"
      action {
        name            = "ECS_LAMBDA_DEPLOY"
        namespace       = "ECS_VARIABLES"
        category        = "Invoke"
        owner           = "AWS"
        version         = "1"
        provider        = "Lambda"
        run_order       = 1
        input_artifacts = ["BuildOutput"]
        configuration = {
          FunctionName = var.lambda_function_name
          UserParameters = "{\"TASK_DEFINITION\": \"${var.fargate-servicename}-dev-sa\", \"SERVICE_NAME\": \"${var.fargate-servicename}\", \"CLUSTER_NAME\": \"${var.fargate-clustername}-dev-sa\"}"
        }
      }
    }
  }
```

##  UserParameters
```json
{
    "TASK_DEFINITION": "[NAME OF ECS TASK]", 
    "SERVICE_NAME": "[NAME OF SERVICE]", 
    "CLUSTER_NAME": "[NAME OF CLUSTER]"
}
```

## Lambda IAM Role
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow"
    }
  ]
}
```

## Lambda IAM Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:*"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RegisterTaskDefinition",
        "ecs:ListTaskDefinitions",
        "ecs:DescribeTaskDefinition",
        "ecs:DeregisterTaskDefinition",
        "ecs:RunTask",
        "ecs:StopTask",
        "ecs:DescribeTasks",
        "ecs:UpdateService"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PassExecutionRole",
      "Effect": "Allow",
      "Action": [
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:PassRole",
        "iam:SimulatePrincipalPolicy"
      ],
      "Resource": "*"
    },
    {
      "Action": [
        "codepipeline:PutJobSuccessResult",
        "codepipeline:PutJobFailureResult"
      ],
      "Effect": "Allow",
      "Resource": "*"
    }
  ]
}
```

##  Lambda Code
```js script
exports.handler = function (event, context, callback) {
    let aws = require("aws-sdk");
    aws.config.update({ region: "af-south-1" });

    let ecs = new aws.ECS();
    let codepipeline = new aws.CodePipeline();
    let jobId = event["CodePipeline.job"].id;

    const userParameters = JSON.parse(
        event["CodePipeline.job"]
            .data
            .actionConfiguration
            .configuration
            .UserParameters);

    let taskDefinition = userParameters.TASK_DEFINITION;
    let serviceName = userParameters.SERVICE_NAME;
    let clusterName = userParameters.CLUSTER_NAME;

    console.log("Task Definition: %s", taskDefinition);
    console.log("Service Name: %s", serviceName);
    console.log("Cluster Name: %s", clusterName);

    // DESCRIBE CURRENT TASK
    console.log("Creating new Task: %s", taskDefinition);
    ecs.describeTaskDefinition( { taskDefinition: taskDefinition },
        function (err, data) {
          if (err) {
            console.log(err, err.stack);
            putJobFailure(err.stack);
          } else {
            console.log("Successfully fetched latest task definition");

            // REMOVING NON REQUIRED JSON FIELDS
            delete data.taskDefinition["revision"];
            delete data.taskDefinition["taskDefinitionArn"];
            delete data.taskDefinition["status"];
            delete data.taskDefinition["requiresAttributes"];
            delete data.taskDefinition["registeredBy"];
            delete data.taskDefinition["registeredAt"];
            delete data.taskDefinition["compatibilities"];

            // REGISTER NEW TASK
            ecs.registerTaskDefinition(data.taskDefinition, function (err, data) {
              if (err) {
                console.log(err, err.stack);
                putJobFailure(err.stack);
              } else {
                let newTaskDefinition = taskDefinition + ":" + data.taskDefinition.revision;
                let oldTaskDefinition = taskDefinition + ":" + (data.taskDefinition.revision - 1);

                console.log("Successfully registered new task definition: %s",  newTaskDefinition);

                // UPDATING SERVICE
                let params = {
                    service: serviceName,
                        cluster: clusterName,
                  taskDefinition: newTaskDefinition,
                    desiredCount: 1,
                };
                ecs.updateService(params, function (err, data) {
                  if (err) {
                    console.log(err, err.stack);
                  } else {
                    console.log("Successfully updated service: %s", serviceName);
                  }
                });

                // DEREGISTER OLD TASK
                params = {
                  taskDefinition: oldTaskDefinition,
                };
                ecs.deregisterTaskDefinition(params, function (err, data) {
                  if (err) {
                    console.log(err, err.stack);
                    putJobFailure(err.stack);
                  } else {
                    let successMessage =
                        "Successfully deregistered previous task definition: " +
                        oldTaskDefinition;
                    console.log(successMessage);
                    putJobSuccess(successMessage);
                  }
                });
              }
            });
          }
        }
    );

    // Notify CodePipeline of a failed job
    let putJobFailure = function (message) {
      aws.config.update({ region: "eu-west-1" });
      codepipeline = new aws.CodePipeline();
      let params = {
        jobId: jobId,
        failureDetails: {
          message: JSON.stringify(message),
          type: "JobFailed",
          externalExecutionId: context.awsRequestId,
        },
      };
      codepipeline.putJobFailureResult(params, function (err, data) {
        context.fail(message);
      });
    };

    // Notify CodePipeline of a successful job
    let putJobSuccess = function (message) {
      aws.config.update({ region: "eu-west-1" });
      codepipeline = new aws.CodePipeline();
      let params = {
        jobId: jobId,
      };
      codepipeline.putJobSuccessResult(params, function (err, data) {
        if (err) {
          context.fail(err);
        } else {
          context.succeed(message);
        }
      });
    };
};

```

# Notes and Docs
I am using Terraform to deploy the infrastructure and some of this can be touched up or enhanced, so please feel free to contribute!
1. [Invoke an AWS Lambda function in a pipeline in CodePipeline ](https://docs.aws.amazon.com/codepipeline/latest/userguide/actions-invoke-lambda-function.html)
2. [Add a cross-Region action in CodePipeline](https://docs.aws.amazon.com/codepipeline/latest/userguide/actions-create-cross-region.html)
3. [AWS CodePipeline for Lambda](https://aws.plainenglish.io/aws-codepipeline-for-lambda-988f4d27c088)
4. [Better Together: Amazon ECS and AWS Lambda](https://aws.amazon.com/blogs/compute/better-together-amazon-ecs-and-aws-lambda/)
